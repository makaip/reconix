import { BrowserWindow, ipcMain } from 'electron'
import type { WsConnection, WsFrame } from '../shared/tabs'

// Memory bounds: oldest connection evicted past the cap, oldest frame dropped
// past the per-connection cap, each frame payload byte-capped.
const MAX_CONNECTIONS = 100
const MAX_FRAMES_PER_CONN = 500
const MAX_FRAME_BYTES = 100_000
const BROADCAST_THROTTLE_MS = 150

/** Issues a CDP command against the currently inspected target; owned by the inspector. */
type Send = <T>(method: string, params?: object) => Promise<T>

export type WebSocketCapture = {
  /** Fed Network.* CDP events from the inspector, which owns the single debugger client. */
  handleNetworkEvent: (method: string, params: Record<string, unknown>, send: Send) => void
  /** Clears capture when the inspected target changes (requestIds are per-target). */
  reset: () => void
  /** Snapshot of captured connections, for IPC and tests. */
  list: () => WsConnection[]
}

// CDP payload shapes — only the fields we read.
type WsCreatedParams = { requestId: string; url: string }
type WsFrameParams = {
  requestId: string
  timestamp: number
  response?: { opcode: number; mask?: boolean; payloadData: string }
}
type WsClosedParams = { requestId: string; timestamp: number }

/** Truncates a payload to the byte cap, returning the kept text and whether it was cut. */
function cap(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_FRAME_BYTES) return { text, truncated: false }
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_FRAME_BYTES)
  return { text: buf.toString('utf8'), truncated: true }
}

/**
 * Captures WebSocket connections and frames of the inspected target over CDP
 * (ARCHITECTURE.MD §11.1 — passive, no new egress). Rides the inspector's single
 * debugger as a NetworkSink alongside response-body capture; the inspector routes
 * every `Network.*` event here and we keep only the `Network.webSocket*` ones.
 */
export function createWebSocketCapture(win: BrowserWindow): WebSocketCapture {
  const conns = new Map<string, WsConnection>()
  let timer: NodeJS.Timeout | null = null

  const list = (): WsConnection[] => [...conns.values()]

  const scheduleBroadcast = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('websocket:changed', list())
      }
    }, BROADCAST_THROTTLE_MS)
  }

  const addFrame = (requestId: string, frame: WsFrame): void => {
    const conn = conns.get(requestId)
    if (!conn) return
    if (conn.frames.length >= MAX_FRAMES_PER_CONN) {
      conn.frames.shift()
      conn.framesTruncated = true
    }
    conn.frames.push(frame)
    scheduleBroadcast()
  }

  const handleNetworkEvent = (
    method: string,
    params: Record<string, unknown>,
    _send: Send
  ): void => {
    switch (method) {
      case 'Network.webSocketCreated': {
        const { requestId, url } = params as unknown as WsCreatedParams
        if (!requestId) return
        if (!conns.has(requestId) && conns.size >= MAX_CONNECTIONS) {
          const oldest = conns.keys().next().value
          if (oldest !== undefined) conns.delete(oldest)
        }
        conns.set(requestId, {
          requestId,
          url: url ?? '',
          createdAt: Date.now(),
          frames: [],
          framesTruncated: false
        })
        scheduleBroadcast()
        return
      }
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        const p = params as unknown as WsFrameParams
        if (!p.requestId || !p.response) return
        const { text, truncated } = cap(p.response.payloadData ?? '')
        addFrame(p.requestId, {
          direction: method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
          opcode: p.response.opcode,
          payload: text,
          payloadTruncated: truncated,
          timestamp: p.timestamp
        })
        return
      }
      case 'Network.webSocketClosed': {
        const { requestId, timestamp } = params as unknown as WsClosedParams
        const conn = conns.get(requestId)
        if (conn) {
          conn.closedAt = timestamp
          scheduleBroadcast()
        }
        return
      }
      default:
        return
    }
  }

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) =>
      event.sender === win.webContents ? fn(...args) : null
    )
  }
  handle('websocket:list', () => list())

  win.on('closed', () => {
    if (timer) clearTimeout(timer)
    ipcMain.removeHandler('websocket:list')
  })

  return { handleNetworkEvent, reset: () => conns.clear(), list }
}
