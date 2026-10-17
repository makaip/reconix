import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

// ipcMain.handle/removeHandler are called at store construction; capture the
// handler so we can drive network:get-body directly, and stub win.on.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sender = { id: 1 }
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, (...args: unknown[]) => fn({ sender }, ...args)),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

import { createBodyStore } from './bodies'

const makeWin = (): BrowserWindow =>
  ({ webContents: sender, on: () => undefined }) as unknown as BrowserWindow

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

beforeEach(() => handlers.clear())

describe('createBodyStore', () => {
  it('assembles request + response + body under one requestId', async () => {
    const store = createBodyStore(makeWin())
    const send = vi.fn().mockResolvedValue({ body: 'hello world', base64Encoded: false })

    store.handleNetworkEvent(
      'Network.requestWillBeSent',
      { requestId: 'r1', request: { url: 'https://x/a', method: 'POST', headers: { h: '1' }, postData: 'q=1' } },
      send
    )
    store.handleNetworkEvent(
      'Network.responseReceived',
      { requestId: 'r1', response: { url: 'https://x/a', status: 200, mimeType: 'text/html', headers: { s: '2' } } },
      send
    )
    store.handleNetworkEvent('Network.loadingFinished', { requestId: 'r1' }, send)
    await flush()

    const rec = store.get('r1')
    expect(rec).toMatchObject({
      requestId: 'r1',
      url: 'https://x/a',
      method: 'POST',
      status: 200,
      mimeType: 'text/html',
      requestBody: 'q=1',
      responseBody: 'hello world',
      responseBase64: false
    })
    expect(send).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' })
  })

  it('does not fetch a body for an unknown requestId', () => {
    const store = createBodyStore(makeWin())
    const send = vi.fn()
    store.handleNetworkEvent('Network.loadingFinished', { requestId: 'ghost' }, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows getResponseBody failures, leaving responseBody unset', async () => {
    const store = createBodyStore(makeWin())
    const send = vi.fn().mockRejectedValue(new Error('No data found'))
    store.handleNetworkEvent(
      'Network.requestWillBeSent',
      { requestId: 'r2', request: { url: 'https://x/b', method: 'GET' } },
      send
    )
    store.handleNetworkEvent('Network.loadingFinished', { requestId: 'r2' }, send)
    await flush()
    expect(store.get('r2')?.responseBody).toBeUndefined()
  })

  it('evicts oldest entries past the cap', () => {
    const store = createBodyStore(makeWin())
    const send = vi.fn()
    for (let i = 0; i < 600; i++) {
      store.handleNetworkEvent(
        'Network.requestWillBeSent',
        { requestId: `r${i}`, request: { url: `https://x/${i}`, method: 'GET' } },
        send
      )
    }
    expect(store.get('r0')).toBeUndefined()
    expect(store.get('r599')).toBeDefined()
  })

  it('reset() drops all captured bodies', () => {
    const store = createBodyStore(makeWin())
    store.handleNetworkEvent(
      'Network.requestWillBeSent',
      { requestId: 'r1', request: { url: 'https://x/a', method: 'GET' } },
      vi.fn()
    )
    store.reset()
    expect(store.get('r1')).toBeUndefined()
  })

  it('serves captured bodies over the network:get-body IPC handler', () => {
    const store = createBodyStore(makeWin())
    store.handleNetworkEvent(
      'Network.requestWillBeSent',
      { requestId: 'r1', request: { url: 'https://x/a', method: 'GET' } },
      vi.fn()
    )
    const ipc = handlers.get('network:get-body')!
    expect((ipc('r1') as { url: string }).url).toBe('https://x/a')
    expect(ipc('nope')).toBeNull()
    expect(ipc(42)).toBeNull()
  })
})
