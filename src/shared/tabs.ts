// Types shared by the main process (tab manager, network capture), preload and renderer.

export type TabInfo = {
  id: number
  /** Page title; empty until the page sets one. */
  title: string
  /** Current URL; empty for a blank tab. */
  url: string
  loading: boolean
}

export type TabsState = {
  tabs: TabInfo[]
  activeId: number | null
  canGoBack: boolean
  canGoForward: boolean
}

export type NavigateResult = { ok: true } | { ok: false; error: string }

export type CapturedRequest = {
  id: string
  tabId: number
  method: string
  url: string
  resourceType: string
  startedAt: number
  statusCode?: number
  fromCache?: boolean
  error?: string
  durationMs?: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
}

export type NetworkStats = {
  total: number
  perTab: Record<number, number>
}

/**
 * A full request/response record including bodies, captured over CDP for the
 * inspected (active) target page. Unlike CapturedRequest (webRequest, all tabs,
 * headers/timing only), this carries the payloads Repeater/diff/intruder need.
 * Keyed by the CDP requestId, which is distinct from CapturedRequest.id.
 */
export type CapturedBody = {
  requestId: string
  url: string
  method: string
  status?: number
  mimeType?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  /** Request payload (e.g. POST body) as reported by CDP, if any. */
  requestBody?: string
  /** Response body text. Base64 when `responseBase64` is true (binary resources). */
  responseBody?: string
  responseBase64?: boolean
  requestBodyTruncated?: boolean
  responseBodyTruncated?: boolean
  /** ms since epoch when the body was captured. */
  capturedAt: number
}
