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

/** A request the user resends via Repeater (host-side replay). Validated as hostile. */
export type ReplayRequestInput = {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}

/** Why a replay was rejected before or during the send. */
export type ReplayRejectReason = 'invalid' | 'denied' | 'rate-limited' | 'network'

/**
 * Result of a replay. The success shape is a superset of diffResponses'
 * ResponseLike (status/body/headers/timingMs), so a result feeds the diff tool
 * directly. Redirects are NOT auto-followed — `redirectedTo` surfaces the target
 * so scope can be re-checked before any manual follow.
 */
export type ReplayResult =
  | {
      ok: true
      status: number
      headers: Record<string, string>
      body: string
      bodyTruncated: boolean
      timingMs: number
      redirectedTo?: string
    }
  | { ok: false; reason: ReplayRejectReason; error: string }

/** A request saved in Repeater: editable, taggable, with its recent response history. */
export type SavedRequest = {
  id: string
  name: string
  tags: string[]
  request: ReplayRequestInput
  /** Recent replay results, oldest first, capped. The last two feed the diff view. */
  responses: ReplayResult[]
  updatedAt: number
}

/** Payload to create (no id) or update (with id) a saved request. */
export type SaveRequestInput = {
  id?: string
  name: string
  tags: string[]
  request: ReplayRequestInput
}
