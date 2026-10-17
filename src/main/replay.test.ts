import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ScopeChecker } from '../shared/scope'
import type { ReplayResult } from '../shared/tabs'

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>()
const sender = { id: 1 }
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => unknown) =>
      handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

import { createReplay } from './replay'

const makeWin = (): BrowserWindow =>
  ({ webContents: sender, on: () => undefined }) as unknown as BrowserWindow
const ALLOW_ALL: ScopeChecker = { isAllowed: () => true }
const DENY_ALL: ScopeChecker = { isAllowed: () => false }

// Drives the registered replay:send IPC handler as the trusted sender.
const invoke = (raw: unknown): Promise<ReplayResult> =>
  handlers.get('replay:send')!({ sender }, raw) as Promise<ReplayResult>

let server: http.Server
let base: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/elsewhere' }).end()
    } else if (req.url === '/big') {
      res.writeHead(200).end('x'.repeat(3_000_000))
    } else if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => res.writeHead(200).end(`got:${body}`))
    } else {
      res.writeHead(200, { 'x-test': 'yes' }).end('hello')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))
beforeEach(() => handlers.clear())

describe('createReplay', () => {
  it('sends an allowed GET and captures status + headers + body', async () => {
    createReplay(makeWin(), ALLOW_ALL)
    const res = await invoke({ method: 'GET', url: `${base}/` })
    expect(res).toMatchObject({ ok: true, status: 200, body: 'hello' })
    expect((res as { headers: Record<string, string> }).headers['x-test']).toBe('yes')
  })

  it('writes a request body and reads it back', async () => {
    createReplay(makeWin(), ALLOW_ALL)
    const res = await invoke({ method: 'POST', url: `${base}/`, body: 'q=1' })
    expect(res).toMatchObject({ ok: true, body: 'got:q=1' })
  })

  it('rejects an out-of-scope URL without opening a socket', async () => {
    createReplay(makeWin(), DENY_ALL)
    // Port 1 has nothing listening; a 'denied' result proves no connect was attempted.
    const res = await invoke({ method: 'GET', url: 'http://127.0.0.1:1/' })
    expect(res).toEqual({ ok: false, reason: 'denied', error: expect.any(String) })
  })

  it('does not auto-follow redirects, surfacing redirectedTo', async () => {
    createReplay(makeWin(), ALLOW_ALL)
    const res = await invoke({ method: 'GET', url: `${base}/redirect` })
    expect(res).toMatchObject({ ok: true, status: 302 })
    expect((res as { redirectedTo: string }).redirectedTo).toBe(`${base}/elsewhere`)
  })

  it('truncates an oversized response body', async () => {
    createReplay(makeWin(), ALLOW_ALL)
    const res = await invoke({ method: 'GET', url: `${base}/big` })
    expect(res).toMatchObject({ ok: true, bodyTruncated: true })
    expect((res as { body: string }).body.length).toBe(2_000_000)
  })

  it('enforces the per-host rate limit', async () => {
    createReplay(makeWin(), ALLOW_ALL, { requestsPerSecond: 0, burst: 1 })
    const first = await invoke({ method: 'GET', url: `${base}/` })
    const second = await invoke({ method: 'GET', url: `${base}/` })
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, reason: 'rate-limited' })
  })

  it('rejects hostile input before sending', async () => {
    createReplay(makeWin(), ALLOW_ALL)
    const cases: unknown[] = [
      { method: 'TRACE', url: `${base}/` },
      { method: 'GET', url: 'ftp://x/' },
      { method: 'GET', url: 'not a url' },
      { method: 'GET', url: `${base}/`, headers: { 'x-bad': 'a\r\nInjected: 1' } },
      { method: 'GET', url: `${base}/`, headers: { x: 1 } },
      'nope'
    ]
    for (const c of cases) {
      const res = await invoke(c)
      expect(res).toMatchObject({ ok: false, reason: 'invalid' })
    }
  })

  it('refuses an untrusted sender', async () => {
    createReplay(makeWin(), ALLOW_ALL)
    const res = (await handlers.get('replay:send')!(
      { sender: { id: 999 } },
      { method: 'GET', url: `${base}/` }
    )) as ReplayResult
    expect(res).toMatchObject({ ok: false, reason: 'invalid', error: 'unauthorized sender' })
  })
})
