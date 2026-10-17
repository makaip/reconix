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

/** One WebSocket frame captured over CDP on the inspected target. */
export type WsFrame = {
  /** 'sent' = client→server, 'received' = server→client. */
  direction: 'sent' | 'received'
  /** CDP opcode: 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode: number
  /** Frame payload, capped at a byte limit; base64 for binary frames per CDP. */
  payload: string
  payloadTruncated: boolean
  /** CDP monotonic timestamp of the frame. */
  timestamp: number
}

/**
 * A WebSocket connection on the inspected target with its captured frames.
 * Frame data comes over CDP (Network.webSocket*) — webRequest in network.ts sees
 * only the handshake (resourceType 'websocket'), never the frames.
 */
export type WsConnection = {
  /** CDP requestId of the socket; stable for the connection's life. */
  requestId: string
  url: string
  createdAt: number
  closedAt?: number
  frames: WsFrame[]
  /** True once oldest frames were dropped past the per-connection cap. */
  framesTruncated: boolean
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

/** A live match/replace rule: rewrite or remove a request header when the URL matches. */
export type InterceptRule = {
  id: string
  enabled: boolean
  name: string
  /** Substring matched against the request URL. Empty = all requests. */
  urlPattern: string
  /** Header name to act on (case-insensitive match). */
  header: string
  action: 'set' | 'remove'
  /** Replacement value for `set`. */
  value?: string
}

/** Payload to create (no id) or update (with id) an intercept rule. */
export type SaveInterceptRuleInput = {
  id?: string
  name: string
  urlPattern: string
  header: string
  action: 'set' | 'remove'
  value?: string
}
