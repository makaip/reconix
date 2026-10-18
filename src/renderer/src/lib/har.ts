import type { CapturedRequest } from '../../../shared/tabs'

// Minimal HAR 1.2 shapes (http://www.softwareishard.com/blog/har-12-spec/). Only the
// fields we populate/read are typed; required-but-unused fields are emitted as spec defaults.
export type HarNameValue = { name: string; value: string }
export type HarEntry = {
  startedDateTime: string
  time: number
  request: {
    method: string
    url: string
    httpVersion: string
    headers: HarNameValue[]
    queryString: HarNameValue[]
    headersSize: number
    bodySize: number
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    headers: HarNameValue[]
    content: { size: number; mimeType: string }
    redirectURL: string
    headersSize: number
    bodySize: number
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
}
export type Har = { log: { version: '1.2'; creator: { name: string; version: string }; entries: HarEntry[] } }

/** One parsed entry, flattened for display/replay (the subset we read back on import). */
export type ParsedHarEntry = {
  method: string
  url: string
  status?: number
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  startedAt: number
  durationMs?: number
}

const toPairs = (headers: Record<string, string> | undefined): HarNameValue[] =>
  headers ? Object.entries(headers).map(([name, value]) => ({ name, value })) : []

const flattenMulti = (headers: Record<string, string[]> | undefined): HarNameValue[] =>
  headers ? Object.entries(headers).map(([name, values]) => ({ name, value: values.join(', ') })) : []

function queryPairs(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

function mimeOf(headers: Record<string, string[]> | undefined): string {
  if (!headers) return ''
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type')
  return key ? (headers[key]?.[0] ?? '') : ''
}

/**
 * Serializes captured requests to HAR 1.2 (ARCHITECTURE.MD §11.1). Carries headers
 * and timing (what webRequest capture has); response bodies are not included because
 * they live under a separate CDP requestId space, so content.size is 0.
 */
export function toHar(requests: CapturedRequest[]): Har {
  const entries: HarEntry[] = requests.map((r) => ({
    startedDateTime: new Date(r.startedAt).toISOString(),
    time: r.durationMs ?? 0,
    request: {
      method: r.method,
      url: r.url,
      httpVersion: 'HTTP/1.1',
      headers: toPairs(r.requestHeaders),
      queryString: queryPairs(r.url),
      headersSize: -1,
      bodySize: -1
    },
    response: {
      status: r.statusCode ?? 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: flattenMulti(r.responseHeaders),
      content: { size: 0, mimeType: mimeOf(r.responseHeaders) },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1
    },
    cache: {},
    timings: { send: 0, wait: r.durationMs ?? 0, receive: 0 }
  }))
  return { log: { version: '1.2', creator: { name: 'Reconix', version: '1' }, entries } }
}

/**
 * Maps parsed HAR entries back into CapturedRequest-shaped rows for the network
 * panel's local display list. Imported rows get a positional `har-<i>` id,
 * resourceType 'imported', and a tabId of `tabIndex` (default -1 = no live tab).
 * Response headers are re-widened to the string[] form CapturedRequest uses.
 */
export function parsedHarToCaptured(parsed: ParsedHarEntry[], tabIndex = -1): CapturedRequest[] {
  return parsed.map((entry, i) => ({
    id: `har-${i}`,
    tabId: tabIndex,
    method: entry.method,
    url: entry.url,
    resourceType: 'imported',
    startedAt: entry.startedAt,
    statusCode: entry.status,
    durationMs: entry.durationMs,
    requestHeaders: entry.requestHeaders,
    responseHeaders: Object.fromEntries(
      Object.entries(entry.responseHeaders).map(([name, value]) => [name, [value]])
    )
  }))
}

const pairsToRecord = (pairs: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!Array.isArray(pairs)) return out
  for (const p of pairs) {
    if (p && typeof p.name === 'string' && typeof p.value === 'string') out[p.name] = p.value
  }
  return out
}

/**
 * Parses a HAR document's entries into flattened records. Treats input as hostile:
 * anything not matching the shape is skipped, and a non-HAR document yields [].
 */
export function fromHar(raw: unknown): ParsedHarEntry[] {
  if (typeof raw !== 'object' || raw === null) return []
  const log = (raw as { log?: unknown }).log
  if (typeof log !== 'object' || log === null) return []
  const entries = (log as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []

  const out: ParsedHarEntry[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const req = (entry as { request?: Record<string, unknown> }).request
    const res = (entry as { response?: Record<string, unknown> }).response
    if (!req || typeof req.method !== 'string' || typeof req.url !== 'string') continue
    const startedRaw = (entry as { startedDateTime?: unknown }).startedDateTime
    const started = typeof startedRaw === 'string' ? Date.parse(startedRaw) : NaN
    const timeRaw = (entry as { time?: unknown }).time
    out.push({
      method: req.method,
      url: req.url,
      status: res && typeof res.status === 'number' ? res.status : undefined,
      requestHeaders: pairsToRecord(req.headers),
      responseHeaders: pairsToRecord(res?.headers),
      startedAt: Number.isFinite(started) ? started : 0,
      durationMs: typeof timeRaw === 'number' ? timeRaw : undefined
    })
  }
  return out
}
