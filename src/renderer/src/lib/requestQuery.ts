import type { CapturedRequest } from '../../../shared/tabs'

/** A narrow filter over already-captured requests. Every field is optional (AND-combined). */
export type RequestQuery = {
  /** Substring matched against the URL host. */
  host?: string
  /** Exact method (case-insensitive). */
  method?: string
  /** Status as an exact code ("404") or a class ("2xx", "4xx", "5xx"). */
  status?: string
  /** Regex matched against the full URL. Invalid patterns match nothing. */
  urlRegex?: string
  /** Name of a query parameter the URL must carry. */
  param?: string
  /** Response size bounds, from Content-Length when present. */
  minBytes?: number
  maxBytes?: number
}

/** Content-Length of a captured response, or undefined when not reported. */
export function responseBytes(request: CapturedRequest): number | undefined {
  const headers = request.responseHeaders
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-length')
  if (!key) return undefined
  const n = Number(headers[key]?.[0])
  return Number.isFinite(n) ? n : undefined
}

function statusMatches(filter: string, code: number | undefined): boolean {
  if (code === undefined) return false
  const f = filter.trim().toLowerCase()
  const classMatch = /^([1-5])xx$/.exec(f)
  if (classMatch) return Math.floor(code / 100) === Number(classMatch[1])
  const exact = Number(f)
  return Number.isFinite(exact) && exact === code
}

function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/**
 * Filters captured requests by the given query (ARCHITECTURE.MD §11.1 history search).
 * Pure and read-only — it narrows the existing capture list, it never fetches or
 * exposes a broader history surface (keeps `query_log` narrow per the 6.4 note).
 */
export function queryRequests(requests: CapturedRequest[], query: RequestQuery): CapturedRequest[] {
  const host = query.host?.trim().toLowerCase()
  const method = query.method?.trim().toUpperCase()
  const status = query.status?.trim()
  const param = query.param?.trim()
  // An invalid regex matches nothing (so the user sees their pattern is wrong, not stale results).
  const regex = query.urlRegex?.trim() ? compileRegex(query.urlRegex.trim()) : undefined

  return requests.filter((request) => {
    let url: URL | null
    try {
      url = new URL(request.url)
    } catch {
      url = null
    }
    if (host && !(url?.hostname.toLowerCase().includes(host) ?? false)) return false
    if (method && request.method.toUpperCase() !== method) return false
    if (status && !statusMatches(status, request.statusCode)) return false
    if (regex === null) return false
    if (regex && !regex.test(request.url)) return false
    if (param && !(url?.searchParams.has(param) ?? false)) return false
    if (query.minBytes !== undefined || query.maxBytes !== undefined) {
      const bytes = responseBytes(request)
      if (bytes === undefined) return false
      if (query.minBytes !== undefined && bytes < query.minBytes) return false
      if (query.maxBytes !== undefined && bytes > query.maxBytes) return false
    }
    return true
  })
}
