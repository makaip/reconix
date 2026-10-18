import http from 'node:http'
import https from 'node:https'
import { BrowserWindow, ipcMain } from 'electron'
import type { ScopeChecker } from '../shared/scope'
import type { ReplayRequestInput, ReplayResult } from '../shared/tabs'

const MAX_BODY_BYTES = 2_000_000
const MAX_HEADER_COUNT = 100
const REQUEST_TIMEOUT_MS = 30_000

// Methods Repeater may resend. Anything else is rejected before a socket opens.
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/**
 * Token bucket per target host. Scope says WHERE a request may go; this bounds
 * HOW HARD an in-scope host is hit — mirroring the egress proxy's limiter so the
 * host-side path is no more permissive than the container path. Conservative by
 * default (1 req/sec/host, burst 1); excess is rejected, never queued (no unbounded
 * backlog). A human raises these knobs only for a host confirmed safe to hammer.
 */
export type RateConfig = { requestsPerSecond: number; burst: number }
const DEFAULT_RATE: RateConfig = { requestsPerSecond: 1, burst: 1 }

type Bucket = { tokens: number; last: number }

function makeLimiter(config: RateConfig) {
  const buckets = new Map<string, Bucket>()
  const rps = Math.max(0, config.requestsPerSecond)
  const burst = Math.max(1, config.burst)
  return (host: string, now = Date.now()): boolean => {
    const b = buckets.get(host) ?? { tokens: burst, last: now }
    // Refill proportional to elapsed time, capped at burst.
    b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * rps)
    b.last = now
    buckets.set(host, b)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
}

// CRLF in a header name/value is request-splitting; reject outright.
const hasControlChars = (s: string): boolean => /[\r\n]/.test(s)

type ValidInput = { method: string; url: URL; headers: Record<string, string>; body?: string }

/** Treats raw IPC input as hostile: wrong types, bad method, CRLF injection, non-http(s) all rejected. */
function validate(raw: unknown): { ok: true; value: ValidInput } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'input must be an object' }
  const r = raw as Record<string, unknown>

  if (typeof r.method !== 'string') return { ok: false, error: 'method must be a string' }
  const method = r.method.toUpperCase()
  if (!ALLOWED_METHODS.has(method)) return { ok: false, error: `method not allowed: ${r.method}` }

  if (typeof r.url !== 'string') return { ok: false, error: 'url must be a string' }
  let url: URL
  try {
    url = new URL(r.url)
  } catch {
    return { ok: false, error: 'url is not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${url.protocol}` }
  }

  const headers: Record<string, string> = {}
  if (r.headers !== undefined) {
    if (typeof r.headers !== 'object' || r.headers === null) {
      return { ok: false, error: 'headers must be an object' }
    }
    const entries = Object.entries(r.headers as Record<string, unknown>)
    if (entries.length > MAX_HEADER_COUNT) return { ok: false, error: 'too many headers' }
    for (const [name, value] of entries) {
      if (typeof value !== 'string') return { ok: false, error: `header ${name} must be a string` }
      if (hasControlChars(name) || hasControlChars(value)) {
        return { ok: false, error: 'header contains control characters' }
      }
      headers[name] = value
    }
  }

  let body: string | undefined
  if (r.body !== undefined) {
    if (typeof r.body !== 'string') return { ok: false, error: 'body must be a string' }
    if (Buffer.byteLength(r.body, 'utf8') > MAX_BODY_BYTES) return { ok: false, error: 'body too large' }
    body = r.body
  }

  return { ok: true, value: { method, url, headers, body } }
}

/** Flattens Node's string | string[] header map to comma-joined strings (ResponseLike shape). */
function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

function send(input: ValidInput): Promise<ReplayResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const transport = input.url.protocol === 'https:' ? https : http
    const req = transport.request(
      input.url,
      { method: input.method, headers: input.headers },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        let truncated = false
        res.on('data', (chunk: Buffer) => {
          if (truncated) return
          total += chunk.length
          if (total > MAX_BODY_BYTES) {
            chunks.push(chunk.subarray(0, chunk.length - (total - MAX_BODY_BYTES)))
            truncated = true
            res.destroy() // stop reading an oversized body
          } else {
            chunks.push(chunk)
          }
        })
        const finish = (): void => {
          const status = res.statusCode ?? 0
          const headers = flattenHeaders(res.headers)
          // A 3xx Location is NOT followed — scope must be re-checked before any follow.
          const redirectedTo =
            status >= 300 && status < 400 && typeof res.headers.location === 'string'
              ? new URL(res.headers.location, input.url).href
              : undefined
          resolve({
            ok: true,
            status,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
            bodyTruncated: truncated,
            timingMs: Date.now() - started,
            ...(redirectedTo ? { redirectedTo } : {})
          })
        }
        res.on('end', finish)
        res.on('close', finish)
      }
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('request timed out')))
    req.on('error', (err) => resolve({ ok: false, reason: 'network', error: err.message }))
    if (input.body !== undefined) req.write(input.body)
    req.end()
  })
}

export type Replay = { close: () => void }

/** A gated send: validate → scope-check → rate-limit → http(s). The single egress path. */
export type Replayer = (raw: unknown) => Promise<ReplayResult>

/**
 * Builds the gated send used by both the replay:send IPC (Repeater "resend") and
 * the Repeater store's send. Every call runs validate (hostile input) → scope-check
 * (DENY by default) → per-host rate limit → Node http(s) with redirects NOT
 * auto-followed. This path does NOT traverse the container egress proxy (that fronts
 * the OpenCode container, not the host), so scope and rate are enforced here instead
 * — scope via the SAME ScopeChecker the proxy compiles from, so verdicts never
 * diverge (§6.5). Keeping ONE replayer means every host-side send is gated identically.
 */
function createReplayer(
  scopeChecker: ScopeChecker,
  rate: RateConfig = DEFAULT_RATE
): Replayer {
  const limiter = makeLimiter(rate)
  return async (raw: unknown): Promise<ReplayResult> => {
    const valid = validate(raw)
    if (!valid.ok) return { ok: false, reason: 'invalid', error: valid.error }
    const { value } = valid
    if (!scopeChecker.isAllowed(value.url.href, value.method)) {
      return { ok: false, reason: 'denied', error: 'URL is out of authorized scope' }
    }
    if (!limiter(value.url.hostname)) {
      return { ok: false, reason: 'rate-limited', error: 'rate limit exceeded for target host' }
    }
    return send(value)
  }
}

/** Host-side request replay for Repeater (ARCHITECTURE.MD §11.1). Wires replay:send to a Replayer. */
export function createReplay(
  win: BrowserWindow,
  scopeChecker: ScopeChecker,
  rate: RateConfig = DEFAULT_RATE
): Replay & { replayer: Replayer } {
  const replayer = createReplayer(scopeChecker, rate)

  ipcMain.removeHandler('replay:send')
  ipcMain.handle('replay:send', (event, raw: ReplayRequestInput) =>
    event.sender === win.webContents
      ? replayer(raw)
      : Promise.resolve<ReplayResult>({ ok: false, reason: 'invalid', error: 'unauthorized sender' })
  )

  const close = (): void => ipcMain.removeHandler('replay:send')
  win.on('closed', close)
  return { close, replayer }
}
