// nuclei_scan — wraps the `nuclei` CLI so the copilot can run templated
// vulnerability checks against one in-scope URL. Tier M: every invocation is
// real egress (nuclei fires hundreds of probe requests), so approval gating is
// handled upstream by the OpenCode permission config keyed off riskTier.
//
// The binary is NOT shipped with Reconix. Set RECONIX_NUCLEI_BIN to an absolute
// path, or put `nuclei` on PATH; otherwise the tool fails with an actionable
// message. Argv-only, no shell: template/tag/severity values are validated
// before they can reach argv, so a value can never smuggle in another flag.
import { spawn, type ChildProcess } from 'node:child_process'
import { defineTool, type Tool } from '../tool'
import { ScopeError, ToolExecError, ToolInputError } from '../errors'
import { urlString } from '../validate'

const NUCLEI_TIMEOUT_MS = 300_000
/** Cap on captured stdout — nuclei JSONL is verbose on big template sets. */
const NUCLEI_MAX_OUTPUT = 8 * 1024 * 1024
/** Grace period after the kill signal for the pipes to drain. */
const KILL_GRACE_MS = 1_000

// Only these shapes are allowed in -tags/-severity/-t values. No leading "-"
// (so a value can never become a flag), no commas (values are comma-joined),
// no whitespace. Absolute template paths (leading "/") are allowed.
const LIST_ITEM_RE = /^\/?[A-Za-z0-9][A-Za-z0-9._/~:+-]*$/

type NucleiListKey = 'tags' | 'severity' | 'templates'

export interface NucleiFinding {
  /** nuclei `template-id`. */
  template: string
  name: string
  severity: string
  /** `matched-at` (or host/url fallback) — the exact URL that matched. */
  matchedAt: string
  extractedResults: string[]
  description: string
}

export interface NucleiScanInput {
  target: string
  tags?: string[]
  severity?: string[]
  templates?: string[]
}

export interface NucleiRunResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  truncated: boolean
}

function nucleiBin(): string {
  const override = (process.env.RECONIX_NUCLEI_BIN ?? '').trim()
  return override === '' ? 'nuclei' : override
}

/** Kills the whole process tree: a bare kill() leaves grandchildren running. */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      })
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/**
 * Runs nuclei argv-only (no shell) with a hard wall-clock cap. Resolves with
 * whatever was captured even when the run times out, so a long scan still
 * yields the findings it produced before the kill.
 */
function runNuclei(args: string[], timeoutMs: number): Promise<NucleiRunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(nucleiBin(), args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: own process group so the timeout can signal the whole tree.
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (err) {
      reject(new ToolExecError(`nuclei_scan: failed to spawn "${nucleiBin()}": ${(err as Error).message}`))
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (grace) clearTimeout(grace)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
        timedOut,
        truncated
      })
    }

    timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      // A grandchild holding the pipes open can delay 'close' forever.
      grace = setTimeout(() => finish(null), KILL_GRACE_MS)
      grace.unref?.()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= NUCLEI_MAX_OUTPUT) {
        truncated = true
        return
      }
      const take = Math.min(chunk.length, NUCLEI_MAX_OUTPUT - stdoutBytes)
      if (take < chunk.length) truncated = true
      stdoutChunks.push(chunk.subarray(0, take))
      stdoutBytes += take
    })
    // stderr is only used to explain a failure; a small tail is plenty.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 8_192) return
      const take = Math.min(chunk.length, 8_192 - stderrBytes)
      stderrChunks.push(chunk.subarray(0, take))
      stderrBytes += take
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (grace) clearTimeout(grace)
      if (err.code === 'ENOENT') {
        reject(
          new ToolExecError(
            `nuclei_scan: "${nucleiBin()}" was not found. Install nuclei ` +
              '(https://github.com/projectdiscovery/nuclei) and put it on PATH, or point ' +
              'RECONIX_NUCLEI_BIN at the binary. In a locked-down build the binary must also be ' +
              'on the deployment allowlist (RECONIX_RUN_TOOL_ALLOWLIST for run_tool, plus the ' +
              'sandbox/broker binary allowlist).'
          )
        )
        return
      }
      reject(new ToolExecError(`nuclei_scan: failed to spawn "${nucleiBin()}": ${err.message}`))
    })
    child.on('close', (code) => finish(code))
  })
}

/** Parses `-jsonl` output (one JSON object per line); junk lines are skipped. */
export function parseNucleiJsonl(stdout: string): { findings: NucleiFinding[]; skipped: number } {
  const findings: NucleiFinding[] = []
  let skipped = 0
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!trimmed.startsWith('{')) {
      skipped++
      continue
    }
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        skipped++
        continue
      }
      obj = parsed as Record<string, unknown>
    } catch {
      // A truncated final line lands here; the rest still parses.
      skipped++
      continue
    }
    const info =
      typeof obj.info === 'object' && obj.info !== null && !Array.isArray(obj.info)
        ? (obj.info as Record<string, unknown>)
        : {}
    const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
    const extracted = Array.isArray(obj['extracted-results'])
      ? (obj['extracted-results'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    const template = str(obj['template-id'], str(obj['templateID']))
    findings.push({
      template,
      name: str(info.name, template),
      severity: str(info.severity, 'unknown'),
      matchedAt: str(obj['matched-at'], str(obj['matched_at'], str(obj.host, str(obj.url)))),
      extractedResults: extracted,
      description: str(info.description)
    })
  }
  return { findings, skipped }
}

const nuclei_scan = defineTool<NucleiScanInput, unknown>({
  name: 'nuclei_scan',
  description:
    'Run the nuclei template scanner against ONE in-scope URL. Tier M — sends real probe traffic ' +
    '(hundreds of requests depending on tags/templates). Optional filters: tags (e.g. ["cve","xss"]), ' +
    'severity (e.g. ["critical","high"]), templates (template ids or paths). Raw JSONL stdout is saved ' +
    'as a trace and returned as rawRef.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['target'],
    properties: {
      target: { type: 'string', description: 'http(s) URL to scan; must be inside engagement scope' },
      tags: { type: 'array', items: { type: 'string' } },
      severity: { type: 'array', items: { type: 'string' } },
      templates: { type: 'array', items: { type: 'string' } }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    required: ['target', 'findings', 'count', 'rawRef'],
    properties: {
      target: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            template: { type: 'string' },
            name: { type: 'string' },
            severity: { type: 'string' },
            matchedAt: { type: 'string' },
            extractedResults: { type: 'array', items: { type: 'string' } },
            description: { type: 'string' }
          }
        }
      },
      count: { type: 'number' },
      rawRef: { type: 'string' },
      timedOut: { type: 'boolean' }
    }
  },
  parse: (raw) => {
    const target = urlString(raw, 'target')
    const r = raw as Record<string, unknown>
    const list = (key: NucleiListKey): string[] | undefined => {
      const v = r[key]
      if (v === undefined) return undefined
      if (!Array.isArray(v)) throw new ToolInputError(`"${key}" must be an array of strings`)
      const out = v.map((item, idx) => {
        if (typeof item !== 'string' || item === '') {
          throw new ToolInputError(`${key}[${idx}] must be a non-empty string`)
        }
        if (item.length > 200 || !LIST_ITEM_RE.test(item)) {
          throw new ToolInputError(
            `${key}[${idx}] is not a valid value: "${item}" — use letters, digits and . _ / ~ : + - only ` +
              '(no spaces or commas; pass multiple values as separate array entries)'
          )
        }
        return item
      })
      return out.length > 0 ? out : undefined
    }
    return {
      target,
      tags: list('tags'),
      severity: list('severity'),
      templates: list('templates')
    }
  },
  // The pipeline gates this target before execute(); the handler re-checks so
  // the tool is safe even if invoked outside the pipeline.
  target: (i) => i.target,
  execute: async (i, ctx) => {
    if (!ctx.scope.isInScope(i.target)) throw new ScopeError(i.target)

    const argv = ['-u', i.target, '-jsonl', '-silent']
    if (i.tags) argv.push('-tags', i.tags.join(','))
    if (i.severity) argv.push('-severity', i.severity.join(','))
    if (i.templates) argv.push('-t', i.templates.join(','))

    const result = await runNuclei(argv, NUCLEI_TIMEOUT_MS)

    // Save the raw stdout even on a failed run: it is the evidence of record.
    const rawRef = await ctx.traces.save('reqresp', result.stdout)
    const { findings } = parseNucleiJsonl(result.stdout)

    if (result.timedOut && result.stdout.trim() === '') {
      throw new ToolExecError(
        `nuclei_scan: nuclei exceeded ${NUCLEI_TIMEOUT_MS / 1000}s with no output (rawRef ${rawRef}). ` +
          'Narrow the scan with tags/severity/templates, or raise the budget in code.',
        true
      )
    }
    if (findings.length === 0 && !result.timedOut && result.code !== 0) {
      const tail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
      throw new ToolExecError(
        `nuclei_scan: nuclei exited with code ${result.code}${tail ? `: ${tail}` : ''} (rawRef ${rawRef}). ` +
          'Check the target is reachable and inside scope, and that the requested tags/templates exist.',
        false
      )
    }

    return {
      target: i.target,
      findings,
      count: findings.length,
      rawRef,
      timedOut: result.timedOut
    }
  }
})

export const nucleiTools: Tool[] = [nuclei_scan as Tool]
