// API.md §3.10 — Recon: passive subdomain enumeration via `subfinder` (§8.6).
// Wraps the external binary argv-only (no shell), with a hard 120s cap and the
// raw stdout/stderr kept as a trace so the agent can re-read exactly what the
// tool saw instead of trusting the parsed summary.
import { defineTool, type Tool, type ToolContext } from '../tool'
import { ScopeError, ToolExecError, ToolInputError } from '../errors'
import { bool, str, strArray } from '../validate'
import { clampString } from '../limits'
import type { ScopeConfig } from '../../../shared/contracts'
import { RunToolSpawnError, runTool } from './runTool'

const SUBFINDER_TIMEOUT_MS = 120_000
/** Inline list cap — the full set always lands in the trace, and a passive
 *  enumeration of a large domain can otherwise blow the context budget. */
const MAX_SUBDOMAINS = 500
/** Per-stream capture cap; subfinder's stderr can be chatty with many sources. */
const MAX_CAPTURE_BYTES = 1_000_000
const MAX_SOURCES = 32

// Bare registrable-ish hostname: labels only, at least one dot, no scheme, no
// port, no path, no wildcard. Anything else is rejected before it reaches argv.
const DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export interface SubfinderInput {
  domain: string
  sources?: string[]
  recursive?: boolean
}

export interface Subdomain {
  host: string
  source: string
}

export interface SubfinderOutput {
  domain: string
  subdomains: Subdomain[]
  count: number
  rawRef: string
  /** Present only when the inline list was capped at MAX_SUBDOMAINS. */
  truncated?: boolean
  omitted?: number
  /** Present only when the run was killed by the 120s cap — results, if any,
   *  are partial. */
  timedOut?: boolean
}

function domainString(raw: unknown): string {
  const v = str(raw, 'domain', 253).trim().toLowerCase()
  if (!DOMAIN_RE.test(v)) {
    throw new ToolInputError(
      '"domain" must be a bare hostname such as "example.com" — no scheme, port, path or wildcard'
    )
  }
  return v
}

function sourceList(raw: unknown): string[] | undefined {
  const r = raw as Record<string, unknown>
  if (r.sources === undefined) return undefined
  const list = strArray(raw, 'sources')
  if (list.length > MAX_SOURCES) {
    throw new ToolInputError(`"sources" must contain at most ${MAX_SOURCES} entries`)
  }
  const out: string[] = []
  for (const [idx, source] of list.entries()) {
    const v = source.trim()
    if (!SOURCE_RE.test(v)) {
      throw new ToolInputError(
        `sources[${idx}] must be a subfinder source name (letters, digits, "_" or "-")`
      )
    }
    if (!out.includes(v)) out.push(v)
  }
  return out.length > 0 ? out : undefined
}

// A scope pattern never carries a port; wildcards are leading-only
// (see scope.ts hostMatches).
function patternHost(pattern: string): string {
  return pattern.startsWith('*.') ? pattern.slice(2) : pattern
}

/**
 * Domain-level scope gate. The pipeline's `target()` check only matches a host
 * against allowed patterns, but enumeration authorizes a *subtree*: if the
 * engagement scope holds `app.example.com`, asking subfinder for `example.com`
 * returns that same asset (plus siblings) and is allowed. A denied pattern
 * anywhere at/under the domain always loses — enumerating around a denied host
 * would be a boundary hole. Declared here rather than via `target()` because
 * the pipeline hook can't express the subtree case; the denial is still an
 * audited outcome (invokeTool catches ScopeError and records it).
 */
function assertDomainInScope(ctx: ToolContext, domain: string): void {
  const cfg = (ctx.scope.config ?? {}) as Partial<ScopeConfig>
  const denied = cfg.denied ?? []
  const allowed = cfg.allowed_hosts ?? []

  const deniedHit = denied.some((pattern) => {
    const host = patternHost(pattern)
    return host === domain || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`)
  })
  if (deniedHit) throw new ScopeError(domain)

  if (ctx.scope.isInScope(domain)) return
  const subtree = allowed.some((pattern) => {
    const host = patternHost(pattern)
    return host === domain || host.endsWith(`.${domain}`)
  })
  if (subtree) return
  throw new ScopeError(domain)
}

function buildArgs(input: SubfinderInput): string[] {
  const args = ['-d', input.domain, '-json', '-silent']
  if (input.sources?.length) args.push('-sources', input.sources.join(','))
  if (input.recursive) args.push('-recursive')
  return args
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

function spawnFailure(err: unknown): ToolExecError {
  if (err instanceof RunToolSpawnError && err.spawnCode === 'ENOENT') {
    return new ToolExecError(
      'subfinder binary not found on PATH — install it ' +
        '(go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest) ' +
        'or add it to PATH, then retry. If it cannot be installed, enumerate manually ' +
        'with navigate + list_links or skip the subdomain step.'
    )
  }
  return new ToolExecError(`subfinder failed to start: ${(err as Error)?.message ?? String(err)}`)
}

function runSubfinder(args: readonly string[]): Promise<RunResult> {
  return runTool('subfinder', args, {
    timeoutMs: SUBFINDER_TIMEOUT_MS,
    maxOutputBytes: MAX_CAPTURE_BYTES
  }).catch((err: unknown) => {
    throw spawnFailure(err)
  })
}

/** subfinder -json emits one JSON object per line: {"host":"a.example.com",
 *  "source":"crtsh", ...}. Unparseable lines (warnings mixed into stdout on
 *  older builds) are skipped, not fatal. */
function parseSubfinderOutput(stdout: string): Subdomain[] {
  const seen = new Set<string>()
  const out: Subdomain[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const rec = parsed as Record<string, unknown>
    const host = typeof rec.host === 'string' ? rec.host.trim().toLowerCase() : ''
    if (!host) continue
    const source =
      typeof rec.source === 'string' && rec.source.trim() ? rec.source.trim() : 'unknown'
    const key = `${host}\u0000${source}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ host: clampString(host, 253), source: clampString(source, 64) })
  }
  return out
}

const subfinder_enum = defineTool<SubfinderInput, SubfinderOutput>({
  name: 'subfinder_enum',
  description:
    'Passively enumerate subdomains of an in-scope domain with subfinder (-json -silent). ' +
    'Returns { host, source } pairs, the total count and a rawRef to the full output trace. ' +
    'Only hosts under the engagement scope are enumerated; no traffic is sent to the target itself.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['domain'],
    properties: {
      domain: { type: 'string', minLength: 1, maxLength: 253 },
      sources: { type: 'array', items: { type: 'string' }, maxItems: MAX_SOURCES },
      recursive: { type: 'boolean' }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    required: ['domain', 'subdomains', 'count', 'rawRef'],
    properties: {
      domain: { type: 'string' },
      subdomains: {
        type: 'array',
        items: {
          type: 'object',
          required: ['host', 'source'],
          properties: { host: { type: 'string' }, source: { type: 'string' } }
        }
      },
      count: { type: 'number' },
      rawRef: { type: 'string' },
      truncated: { type: 'boolean' },
      omitted: { type: 'number' },
      timedOut: { type: 'boolean' }
    }
  },
  parse: (raw) => ({
    domain: domainString(raw),
    sources: sourceList(raw),
    recursive: bool(raw, 'recursive', false)
  }),
  execute: async (i, ctx) => {
    assertDomainInScope(ctx, i.domain)
    const args = buildArgs(i)
    const run = await runSubfinder(args)
    const found = parseSubfinderOutput(run.stdout)

    // Persist before any error path so a failed/timed-out enumeration is still
    // evidence the agent (and the operator) can inspect.
    const rawRef = await ctx.traces.save(
      'trace',
      JSON.stringify({
        tool: 'subfinder_enum',
        argv: ['subfinder', ...args],
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        stdout: run.stdout,
        stderr: run.stderr
      })
    )

    if (run.timedOut && found.length === 0) {
      throw new ToolExecError(
        `subfinder timed out after ${SUBFINDER_TIMEOUT_MS / 1000}s with no output — ` +
          `narrow the run with "sources" or drop "recursive" and retry (raw: ${rawRef})`
      )
    }
    if (!run.timedOut && run.exitCode !== null && run.exitCode !== 0 && found.length === 0) {
      const detail = clampString(run.stderr.trim(), 300) || '<no stderr>'
      throw new ToolExecError(
        `subfinder exited ${run.exitCode} without results: ${detail} (raw: ${rawRef})`,
        false
      )
    }

    const { items, omitted } = found.length > MAX_SUBDOMAINS
      ? { items: found.slice(0, MAX_SUBDOMAINS), omitted: found.length - MAX_SUBDOMAINS }
      : { items: found, omitted: 0 }

    const output: SubfinderOutput = {
      domain: i.domain,
      subdomains: items,
      count: found.length,
      rawRef
    }
    if (omitted > 0) {
      output.truncated = true
      output.omitted = omitted
    }
    if (run.timedOut) output.timedOut = true // partial list, killed at the cap
    return output
  }
})

export const subfinderTools: Tool[] = [subfinder_enum]
