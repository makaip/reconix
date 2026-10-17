import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createWebSocketCapture } from './websocket'

// Minimal BrowserWindow stub: capture never touches the real window during these
// tests (broadcasts are throttled behind a timer we don't advance), but reset/list
// are synchronous. ipcMain.handle is a no-op via the electron mock below.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))

const fakeWin = {
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() },
  on: vi.fn()
} as unknown as BrowserWindow

const noSend = (async () => undefined) as <T>(m: string, p?: object) => Promise<T>

const created = (requestId: string, url: string): [string, Record<string, unknown>] => [
  'Network.webSocketCreated',
  { requestId, url }
]
const frame = (
  dir: 'Sent' | 'Received',
  requestId: string,
  opcode: number,
  payloadData: string,
  timestamp = 1
): [string, Record<string, unknown>] => [
  `Network.webSocketFrame${dir}`,
  { requestId, timestamp, response: { opcode, payloadData } }
]

describe('createWebSocketCapture', () => {
  it('records a connection on webSocketCreated', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent(...created('ws1', 'wss://t/sock'), noSend)
    const conns = cap.list()
    expect(conns).toHaveLength(1)
    expect(conns[0]).toMatchObject({ requestId: 'ws1', url: 'wss://t/sock', frames: [] })
  })

  it('captures sent and received frames with direction and opcode', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent(...created('ws1', 'wss://t'), noSend)
    cap.handleNetworkEvent(...frame('Sent', 'ws1', 1, 'hello'), noSend)
    cap.handleNetworkEvent(...frame('Received', 'ws1', 1, 'world'), noSend)
    const { frames } = cap.list()[0]
    expect(frames).toEqual([
      { direction: 'sent', opcode: 1, payload: 'hello', payloadTruncated: false, timestamp: 1 },
      { direction: 'received', opcode: 1, payload: 'world', payloadTruncated: false, timestamp: 1 }
    ])
  })

  it('ignores frames for an unknown connection', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent(...frame('Sent', 'ghost', 1, 'x'), noSend)
    expect(cap.list()).toEqual([])
  })

  it('ignores non-WebSocket Network.* events', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent('Network.requestWillBeSent', { requestId: 'r1' }, noSend)
    expect(cap.list()).toEqual([])
  })

  it('marks the connection closed on webSocketClosed', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent(...created('ws1', 'wss://t'), noSend)
    cap.handleNetworkEvent('Network.webSocketClosed', { requestId: 'ws1', timestamp: 42 }, noSend)
    expect(cap.list()[0].closedAt).toBe(42)
  })

  it('truncates oversized frame payloads and flags it', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent(...created('ws1', 'wss://t'), noSend)
    const big = 'a'.repeat(200_000)
    cap.handleNetworkEvent(...frame('Sent', 'ws1', 1, big), noSend)
    const f = cap.list()[0].frames[0]
    expect(f.payloadTruncated).toBe(true)
    expect(f.payload.length).toBe(100_000)
  })

  it('drops oldest frames past the per-connection cap and flags truncation', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent(...created('ws1', 'wss://t'), noSend)
    for (let i = 0; i < 505; i++) {
      cap.handleNetworkEvent(...frame('Sent', 'ws1', 1, `f${i}`, i), noSend)
    }
    const conn = cap.list()[0]
    expect(conn.frames).toHaveLength(500)
    expect(conn.framesTruncated).toBe(true)
    // oldest 5 dropped -> first retained frame is f5
    expect(conn.frames[0].payload).toBe('f5')
  })

  it('reset() clears all captured connections', () => {
    const cap = createWebSocketCapture(fakeWin)
    cap.handleNetworkEvent(...created('ws1', 'wss://t'), noSend)
    cap.reset()
    expect(cap.list()).toEqual([])
  })
})
