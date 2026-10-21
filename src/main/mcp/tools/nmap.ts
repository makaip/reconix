// API.md §3.7 (post-MVP) — Host/service discovery wrapping the system `nmap` binary.
// argv-only, no shell: the handler never interpolates the host/ports/scripts into
// a command string, so there is no shell-injection surface. The scan is capped at
// 300s and its raw XML is stored as a trace (the agent reads it back with
// get_trace), keeping large scan output out of the tool result.
import { spawn } from 'node:child_process'
import { defineTool, type Tool } from '../tool'
import { ScopeError, ToolExecError, ToolInputError } from '../errors'
import { bool, optStr, str, strArray } from '../validate'

const SCAN_TIMEOUT_MS = 300_000
// Nmap XML for a /24 with -sV is comfortably under 1 MB; cap well above that so
// a runaway target list can't exhaust memory, while still reporting truncation.
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 256 * 1024

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
}

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
 * Kills the whole process tree: nmap spawns no children today, but a wrapper
 * script on PATH would, and child.kill() only signals the direct child. On
 * POSIX the child is spawned detached (own process group) so a negative pid
 * signals the group. Mirrors the helper in probes.ts (run_tool).
 */
function killProcessTree(child: import('node:child_process').ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
        'error',
        () => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      )
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

interface NmapRun {
  xml: string
  stderr: string
  exitCode: number | null
  truncated: boolean
}

function runNmap(args: string[]): Promise<NmapRun> {
  return new Promise((resolve, reject) => {
    let child: import('node:child_process').ChildProcess
    try {
      child = spawn('nmap', args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (err) {
      reject(new ToolExecError(`nmap_scan: could not start nmap — ${(err as Error).message}`))
      return
    }

    const out: Buffer[] = []
    const errOut: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false
    let grace: NodeJS.Timeout | null = null

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      resolve({
        xml: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
        exitCode: code,
        truncated
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      // A grandchild holding the pipes open can delay 'close' forever.
      grace = setTimeout(() => finish(null), 1_000)
      grace.unref?.()
    }, SCAN_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_STDOUT_BYTES) {
        truncated = true
        return
      }
      const take = Math.min(chunk.length, MAX_STDOUT_BYTES - outBytes)
      if (take < chunk.length) truncated = true
      out.push(chunk.subarray(0, take))
      outBytes += take
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return
      const take = Math.min(chunk.length, MAX_STDERR_BYTES - errBytes)
      errOut.push(chunk.subarray(0, take))
      errBytes += take
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new ToolExecError(
            'nmap_scan: nmap is not installed (binary not found on PATH) — no scan was run. ' +
              'Install nmap (e.g. `apt install nmap`, `brew install nmap`, or the Windows installer) and retry, ' +
              'or fall back to passive recon: navigate to the host and inspect get_page_info / get_network_log.'
          )
        )
        return
      }
      reject(new ToolExecError(`nmap_scan: nmap failed to spawn — ${err.message}`))
    })
    child.on('close', (code) => {
      if (timedOut) {
        settled = true
        clearTimeout(timer)
        if (grace) clearTimeout(grace)
        reject(
          new ToolExecError(
            `nmap_scan: scan timed out after ${SCAN_TIMEOUT_MS / 1000}s (host unresponsive or too many ports). ` +
              'Retry with a narrower "ports" range or without serviceVersion.',
            true
          )
        )
        return
      }
      finish(code)
    })
  })
}

const nmap_scan = defineTool<NmapInput, Record<string, unknown>>({
  name: 'nmap_scan',
  description:
    'Run an nmap scan against a single in-scope host (service/version detection, --open). Returns open ports with service+version, OS guess if detected, and a rawRef to the full XML trace. Requires nmap on PATH; capped at 300s.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['host'],
    properties: {
      host: { type: 'string', minLength: 1, description: 'Single hostname or IP (no ranges, CIDR, or lists).' },
      ports: { type: 'string', description: 'nmap port spec, e.g. "22,80,443" or "1-1024". Omit for nmap defaults.' },
      serviceVersion: { type: 'boolean', description: 'Add -sV (service/version detection). Slower but richer.' },
      scripts: { type: 'array', items: { type: 'string' }, description: 'NSE script names/categories, e.g. ["http-title"] or ["default","safe"]. Passed as --script=a,b.' }
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
      warning: { type: 'string' }
    },
    required: ['host', 'ports', 'rawRef']
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
      scripts
    }
  },
  // NOTE: no `target` hook on purpose. The pipeline's target hook is
  // unconditional, but this tool must allow a host when the engagement has no
  // host allowlist (the active-tab scope is empty until a page is open). The
  // scope decision therefore lives in execute(), where the config is readable.
  execute: async (i, ctx) => {
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

    const run = await runNmap(args)
    const stderrTail = run.stderr.trim().slice(-1000)

    if (!run.xml.includes('<nmaprun')) {
      // nmap exits non-zero on an unreachable/unauthorized target or a bad
      // argv; without any XML there is nothing to parse and nothing to trace.
      throw new ToolExecError(
        `nmap_scan: nmap produced no XML output (exit ${run.exitCode ?? 'signal'})` +
          (stderrTail ? ` — ${stderrTail}` : ' — check the host resolves and is reachable') +
          '. If the host is down or filtered, results are inconclusive rather than "no open ports".'
      )
    }

    const scan = parseNmapXml(run.xml, i.host)
    const rawRef = await ctx.traces.save('trace', run.xml)

    const warnings: string[] = []
    if (run.exitCode !== 0 && stderrTail) warnings.push(`nmap exited ${run.exitCode}: ${stderrTail}`)
    if (run.truncated) warnings.push('XML output was truncated at 8 MB; the rawRef trace is incomplete')

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
})

export const nmapTools: Tool[] = [nmap_scan as Tool]
