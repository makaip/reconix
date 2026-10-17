import { BrowserWindow, ipcMain } from 'electron'
import type { CapturedBody } from '../shared/tabs'

// Keep memory bounded: only the most recent requests, each body capped.
const MAX_BODIES = 500
const MAX_BODY_BYTES = 2_000_000

/** CDP sends a flat object of header name -> value; normalize to a plain record. */
type CdpHeaders = Record<string, string> | undefined

type RequestWillBeSentParams = {
  requestId: string
  request: { url: string; method: string; headers?: CdpHeaders; postData?: string; hasPostData?: boolean }
}
type ResponseReceivedParams = {
  requestId: string
  response: { url: string; status: number; mimeType?: string; headers?: CdpHeaders }
}
type LoadingFinishedParams = { requestId: string }
type GetResponseBodyResult = { body: string; base64Encoded: boolean }

/** Issues a CDP command against the currently inspected target; owned by the inspector. */
type Send = <T>(method: string, params?: object) => Promise<T>

export type BodyStore = {
  /** Fed Network.* CDP events from the inspector, which owns the single debugger client. */
  handleNetworkEvent: (method: string, params: Record<string, unknown>, send: Send) => void
  /** Clears capture when the inspected target changes (requestIds are per-target). */
  reset: () => void
  /** Lookup for later tools (Repeater, diff, intruder). */
  get: (requestId: string) => CapturedBody | undefined
}

/** Truncates a string to the byte cap, returning the kept text and whether it was cut. */
function cap(text: string): { text: string; truncated: boolean } {
  // Byte length, not char length — bodies are UTF-8 on the wire.
  if (Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES) return { text, truncated: false }
  // Slice by bytes, then drop a possibly-split trailing char.
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_BODY_BYTES)
  return { text: buf.toString('utf8'), truncated: true }
}

/**
 * Records full request/response bodies for the inspected target over CDP. The
 * inspector owns the debugger (only one client may attach per webContents), so
 * it forwards Network.* events here and lends us its `send` to pull bodies on
 * loadingFinished. Capture is best-effort: redirects, cached responses and
 * bodyless requests simply leave `responseBody` unset.
 */
export function createBodyStore(win: BrowserWindow): BodyStore {
  // Insertion-ordered; oldest evicted first once over MAX_BODIES.
  const bodies = new Map<string, CapturedBody>()

  const evictIfNeeded = (): void => {
    while (bodies.size > MAX_BODIES) {
      const oldest = bodies.keys().next().value
      if (oldest === undefined) break
      bodies.delete(oldest)
    }
  }

  const upsert = (requestId: string, patch: Partial<CapturedBody>): CapturedBody => {
    const existing = bodies.get(requestId)
    if (existing) {
      Object.assign(existing, patch)
      return existing
    }
    const created: CapturedBody = { requestId, url: '', method: '', capturedAt: Date.now(), ...patch }
    bodies.set(requestId, created)
    evictIfNeeded()
    return created
  }

  const captureBody = async (requestId: string, send: Send): Promise<void> => {
    try {
      const { body, base64Encoded } = await send<GetResponseBodyResult>('Network.getResponseBody', {
        requestId
      })
      // The request may have been evicted while the body was in flight.
      if (!bodies.has(requestId)) return
      if (base64Encoded) {
        const truncated = body.length > MAX_BODY_BYTES
        upsert(requestId, {
          responseBody: truncated ? body.slice(0, MAX_BODY_BYTES) : body,
          responseBase64: true,
          responseBodyTruncated: truncated,
          capturedAt: Date.now()
        })
      } else {
        const { text, truncated } = cap(body)
        upsert(requestId, {
          responseBody: text,
          responseBase64: false,
          responseBodyTruncated: truncated,
          capturedAt: Date.now()
        })
      }
    } catch {
      // No body available (redirect, 204, cached, or target detached) — leave unset.
    }
  }

  const handleNetworkEvent = (
    method: string,
    params: Record<string, unknown>,
    send: Send
  ): void => {
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request } = params as unknown as RequestWillBeSentParams
      if (!requestId || !request) return
      const patch: Partial<CapturedBody> = {
        url: request.url,
        method: request.method,
        requestHeaders: request.headers
      }
      if (typeof request.postData === 'string') {
        const { text, truncated } = cap(request.postData)
        patch.requestBody = text
        patch.requestBodyTruncated = truncated
      }
      upsert(requestId, patch)
    } else if (method === 'Network.responseReceived') {
      const { requestId, response } = params as unknown as ResponseReceivedParams
      if (!requestId || !response) return
      upsert(requestId, {
        url: response.url,
        status: response.status,
        mimeType: response.mimeType,
        responseHeaders: response.headers
      })
    } else if (method === 'Network.loadingFinished') {
      const { requestId } = params as unknown as LoadingFinishedParams
      if (!requestId || !bodies.has(requestId)) return
      void captureBody(requestId, send)
    }
  }

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) =>
      event.sender === win.webContents ? fn(...args) : null
    )
  }
  handle('network:get-body', (requestId) =>
    typeof requestId === 'string' ? (bodies.get(requestId) ?? null) : null
  )

  win.on('closed', () => ipcMain.removeHandler('network:get-body'))

  return {
    handleNetworkEvent,
    reset: () => bodies.clear(),
    get: (requestId) => bodies.get(requestId)
  }
}
