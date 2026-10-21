// API.md §3.7 (post-MVP) — Host/service discovery wrapping the system `nmap` binary.
// argv-only, no shell: the handler never interpolates the host/ports/scripts into
// a command string, so there is no shell-injection surface. The scan is capped at
// 300s and its raw XML is stored as a trace (the agent reads it back with
// get_trace), keeping large scan output out of the tool result.
import { defineTool, type Tool, type ToolContext } from '../tool'
import { ScopeError, ToolExecError, ToolInputError } from '../errors'
import { bool, optStr, str, strArray } from '../validate'
import { jobStore } from '../jobs'
import { RunToolSpawnError, runTool, type RunToolResult } from './runTool'

const SCAN_TIMEOUT_MS = 300_000
// Nmap XML for a /24 with -sV is comfortably under 1 MB; cap well above that so
// a runaway target list can't exhaust memory, while still reporting truncation.
const MAX_XML_BYTES = 8 * 1024 * 1024

// A single host or address — deliberately NOT a range/CIDR/multiple-host spec:
// "10.0.0.1-254" or "a,b" cannot be scope-checked as one host, so they would
// bypass the per-target scope decision.
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
// nmap port specs: 80, 22,80, 1-1024, T:80,U:53, 8000-8100,...
const PORT_SPEC_RE = /^(?:[TUS]:)?\d+(?:-\d+)?(?:,(?:[TUS]:)?\d+(?:-\d+)?)*$/
// Script categories/names (default, vuln, http-title, ...). Must not start with
// "-": an argv element like "--script-exec" would otherwise be smuggled in.
const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9_.*,?-]*$/

export interface NmapInput {
  host: string
  ports?: string
  serviceVersion?: boolean
  scripts?: string[]
  /** Run detached and return a jobId instead of blocking (see jobs.ts). */
  background?: boolean
}

/** Returned in place of the scan result when `background: true`. */
type BackgroundHandle = { jobId: string; status: string; target?: string }

export interface NmapPort {
  port: number
  protocol: string
  state: string
  service?: string
  version?: string
}

export interface NmapOs {
  name: string
  accuracy?: number
}

export interface NmapScan {
  host: string
  address?: string
  ports: NmapPort[]
  os?: NmapOs
  extraPorts?: { state: string; count: number }[]
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

/** Pulls one attribute out of a raw tag-attribute string. */
function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
  return m ? decodeXml(m[1]) : undefined
}

/**
 * Parses the subset of nmap's XML (-oX -) the agent needs: resolved host,
 * open ports with service/version, and OS matches. Regex-based on purpose — the
 * output is machine-generated and stable, and this avoids an XML dependency.
 */
export function parseNmapXml(xml: string, fallbackHost: string): NmapScan {
  const hostname =
    /<hostname\s+name="([^"]+)"[^>]*type="user"/i.exec(xml)?.[1] ??
    /<hostname\s+name="([^"]+)"/i.exec(xml)?.[1]
  const address = /<address\s+addr="([^"]+)"[^>]*addrtype="(?:ipv4|ipv6)"/i.exec(xml)?.[1]

  const ports: NmapPort[] = []
  const portRe = /<port\s+([^>]*)>([\s\S]*?)<\/port>/gi
  for (let m = portRe.exec(xml); m !== null; m = portRe.exec(xml)) {
    const portAttrs = m[1]
    const body = m[2]
    const port = Number.parseInt(attr(portAttrs, 'portid') ?? '', 10)
    if (!Number.isFinite(port)) continue

    const serviceAttrs = /<service\s+([^>]*?)\/?>/i.exec(body)?.[1] ?? ''
    const product = attr(serviceAttrs, 'product')
    const version = attr(serviceAttrs, 'version')
    const extraInfo = attr(serviceAttrs, 'extrainfo')
    const versionText = [product, version, extraInfo].filter((p): p is string => Boolean(p)).join(' ')

    ports.push({
      port,
      protocol: attr(portAttrs, 'protocol') ?? 'tcp',
      state: /<state\s+state="([^"]*)"/i.exec(body)?.[1] ?? 'unknown',
      service: attr(serviceAttrs, 'name'),
      version: versionText || undefined
    })
  }

  const osAttrs = /<osmatch\s+([^>]*)>/i.exec(xml)?.[1]
  const osName = osAttrs ? attr(osAttrs, 'name') : undefined
  const osAccuracy = osAttrs ? Number.parseInt(attr(osAttrs, 'accuracy') ?? '', 10) : Number.NaN
  const os: NmapOs | undefined = osName
    ? { name: osName, accuracy: Number.isFinite(osAccuracy) ? osAccuracy : undefined }
    : undefined

  const extraPorts: { state: string; count: number }[] = []
  const extraRe = /<extraports\s+state="([^"]+)"\s+count="(\d+)"/gi
  for (let m = extraRe.exec(xml); m !== null; m = extraRe.exec(xml)) {
    const count = Number.parseInt(m[2], 10)
    if (Number.isFinite(count)) extraPorts.push({ state: decodeXml(m[1]), count })
  }

  return {
    host: hostname ? decodeXml(hostname) : (address ?? fallbackHost),
    address,
    ports,
    os,
    extraPorts: extraPorts.length > 0 ? extraPorts : undefined
  }
}

/** Strips a port / IPv6 brackets so the scope checker sees a bare hostname. */
function bareHost(host: string): string {
  const trimmed = host.trim().replace(/^\[|\]$/g, '')
  if (trimmed.includes(':') && !trimmed.includes('::')) return trimmed.split(':')[0]
  return trimmed
}

/**
 * Runs nmap through the shared runner (argv-only, process-tree kill on the
 * wall-clock cap). A missing binary keeps nmap's actionable install hint.
 */
async function runNmap(args: string[], signal?: AbortSignal): Promise<RunToolResult> {
  try {
    return await runTool('nmap', args, {
      timeoutMs: SCAN_TIMEOUT_MS,
      maxOutputBytes: MAX_XML_BYTES,
      signal
    })
  } catch (err) {
    if (err instanceof RunToolSpawnError && err.spawnCode === 'ENOENT') {
      throw new ToolExecError(
        'nmap_scan: nmap is not installed (binary not found on PATH) — no scan was run. ' +
          'Install nmap (e.g. `apt install nmap`, `brew install nmap`, or the Windows installer) and retry, ' +
          'or fall back to passive recon: navigate to the host and inspect get_page_info / get_network_log.'
      )
    }
    throw err instanceof RunToolSpawnError
      ? new ToolExecError(`nmap_scan: nmap failed to spawn — ${err.message}`)
      : err
  }
}

/**
 * The blocking scan body — scope decision, argv build, run, parse. Extracted so
 * `background: true` can hand it to the job store and the inline path can still
 * run it directly. `signal` kills the spawned scan when the job is cancelled.
 */
async function runHeavy(
  i: NmapInput,
  ctx: ToolContext,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const cfg = ctx.scope.config
  const host = bareHost(i.host)
  let note: string | undefined
  if (cfg.allowed_hosts.length === 0 && cfg.denied.length === 0) {
    // No engagement scope loaded — the app has no host allowlist to check
    // against. Proceed, but tell the agent the decision was unverified so it
    // can be recorded as such.
    note =
      'no engagement scope loaded (allowed_hosts is empty) — the host could not be verified against an allowlist; confirm written authorization covers it before acting on these results'
  } else if (!ctx.scope.isInScope(host)) {
    throw new ScopeError(i.host)
  }

  const args: string[] = []
  if (i.serviceVersion) args.push('-sV')
  if (i.ports) args.push('-p', i.ports)
  if (i.scripts && i.scripts.length > 0) args.push(`--script=${i.scripts.join(',')}`)
  args.push('--open', '-oX', '-', i.host)

  const run = await runNmap(args, signal)
  if (run.timedOut) {
    throw new ToolExecError(
      `nmap_scan: scan timed out after ${SCAN_TIMEOUT_MS / 1000}s (host unresponsive or too many ports). ` +
        'Retry with a narrower "ports" range or without serviceVersion.',
      true
    )
  }
  const stderrTail = run.stderr.trim().slice(-1000)

  if (!run.stdout.includes('<nmaprun')) {
    // nmap exits non-zero on an unreachable/unauthorized target or a bad
    // argv; without any XML there is nothing to parse and nothing to trace.
    throw new ToolExecError(
      `nmap_scan: nmap produced no XML output (exit ${run.exitCode ?? 'signal'})` +
        (stderrTail ? ` — ${stderrTail}` : ' — check the host resolves and is reachable') +
        '. If the host is down or filtered, results are inconclusive rather than "no open ports".'
    )
  }

  const scan = parseNmapXml(run.stdout, i.host)
  const rawRef = await ctx.traces.save('trace', run.stdout)

  const warnings: string[] = []
  if (run.exitCode !== 0 && stderrTail) warnings.push(`nmap exited ${run.exitCode}: ${stderrTail}`)
  if (run.stdoutTruncated) warnings.push('XML output was truncated at 8 MB; the rawRef trace is incomplete')

  return {
    host: scan.host,
    address: scan.address,
    ports: scan.ports,
    os: scan.os,
    extraPorts: scan.extraPorts,
    rawRef,
    ...(note ? { note } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {})
  }
}

const nmap_scan = defineTool<NmapInput, Record<string, unknown>>({
  name: 'nmap_scan',
  description:
    'Run an nmap scan against a single in-scope host (service/version detection, --open). Returns open ports with service+version, OS guess if detected, and a rawRef to the full XML trace. Requires nmap on PATH; capped at 300s. Set background: true to get a jobId immediately and poll get_job_status / get_job_result instead of blocking.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['host'],
    properties: {
      host: { type: 'string', minLength: 1, description: 'Single hostname or IP (no ranges, CIDR, or lists).' },
      ports: { type: 'string', description: 'nmap port spec, e.g. "22,80,443" or "1-1024". Omit for nmap defaults.' },
      serviceVersion: { type: 'boolean', description: 'Add -sV (service/version detection). Slower but richer.' },
      scripts: { type: 'array', items: { type: 'string' }, description: 'NSE script names/categories, e.g. ["http-title"] or ["default","safe"]. Passed as --script=a,b.' },
      background: { type: 'boolean', description: 'Run in the background and return a jobId immediately instead of blocking. Poll get_job_status / get_job_result.' }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      host: { type: 'string' },
      address: { type: 'string' },
      ports: { type: 'array' },
      os: { type: 'object' },
      extraPorts: { type: 'array' },
      rawRef: { type: 'string' },
      note: { type: 'string' },
      warning: { type: 'string' },
      // Background shape (`background: true`): a job handle, no scan result yet.
      jobId: { type: 'string' },
      status: { type: 'string' },
      target: { type: 'string' }
    }
  },
  parse: (raw) => {
    const host = str(raw, 'host', 253).trim()
    // A numeric range ("10.0.0.1-254") passes the hostname character check but
    // is not one host — nmap would expand it past the single in-scope target.
    if (/^[0-9.-]+$/.test(host) && host.includes('-')) {
      throw new ToolInputError(
        '"host" must be a single hostname or IP address — numeric ranges (e.g. "10.0.0.1-254") are not accepted; scan each in-scope host separately'
      )
    }
    if (!HOST_RE.test(host)) {
      throw new ToolInputError(
        '"host" must be a single hostname or IP address (letters, digits, ".", "-", "_", ":") — ranges, CIDR blocks and comma lists are not accepted'
      )
    }

    const ports = optStr(raw, 'ports')
    if (ports !== undefined) {
      if (ports.length > 512) throw new ToolInputError('"ports" must be at most 512 characters')
      if (!PORT_SPEC_RE.test(ports)) {
        throw new ToolInputError(
          '"ports" must be an nmap port spec such as "80", "22,80,443", "1-1024", or "T:80,U:53"'
        )
      }
    }

    const scripts = raw && typeof raw === 'object' && (raw as Record<string, unknown>).scripts !== undefined
      ? strArray(raw, 'scripts')
      : undefined
    if (scripts) {
      if (scripts.length > 50) throw new ToolInputError('"scripts" may list at most 50 entries')
      for (const s of scripts) {
        if (s.length > 128 || !SCRIPT_RE.test(s)) {
          throw new ToolInputError(
            `invalid script name "${s}" — use NSE script names or categories (letters, digits, "_", "-", ".", "*", "?")`
          )
        }
      }
      if (scripts.length === 0) {
        throw new ToolInputError('"scripts" must not be an empty array — omit it to run no scripts')
      }
    }

    return {
      host,
      ports,
      serviceVersion: bool(raw, 'serviceVersion', false),
      scripts,
      // Only surfaced when set, so the parsed shape stays minimal.
      ...(bool(raw, 'background', false) ? { background: true } : {})
    }
  },
  // NOTE: no `target` hook on purpose. The pipeline's target hook is
  // unconditional, but this tool must allow a host when the engagement has no
  // host allowlist (the active-tab scope is empty until a page is open). The
  // scope decision therefore lives in execute(), where the config is readable.
  execute: async (i, ctx) => {
    // No `target` hook (see above), so a background job records no target; the
    // scope decision stays inside the job body exactly as it does inline.
    if (i.background === true) {
      const job = await jobStore.start('nmap_scan', undefined, async (handle) =>
        runHeavy(i, ctx, handle.signal)
      )
      return { jobId: job.id, status: job.status } as BackgroundHandle
    }
    return runHeavy(i, ctx)
  }
})

export const nmapTools: Tool[] = [nmap_scan as Tool]
