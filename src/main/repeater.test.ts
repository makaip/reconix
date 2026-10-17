import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ReplayResult, SavedRequest } from '../shared/tabs'
import type { Replayer } from './replay'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
// One object serves as both event.sender and win.webContents so the sender guard passes.
const sender = {
  id: 1,
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => sent.push({ channel, payload })
}
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, (...args: unknown[]) => fn({ sender }, ...args)),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

import { createRepeater } from './repeater'

const makeWin = (): BrowserWindow =>
  ({ isDestroyed: () => false, webContents: sender, on: () => undefined }) as unknown as BrowserWindow

const ok = (body: string, status = 200): ReplayResult => ({
  ok: true,
  status,
  headers: {},
  body,
  bodyTruncated: false,
  timingMs: 1
})

const call = <T>(channel: string, ...args: unknown[]): T => handlers.get(channel)!(...args) as T
const req = { method: 'GET', url: 'https://x/' }

beforeEach(() => {
  handlers.clear()
  sent.length = 0
})

describe('createRepeater', () => {
  it('creates, updates, lists and deletes saved requests', () => {
    createRepeater(makeWin(), vi.fn())
    const created = call<SavedRequest>('repeater:save', { name: 'login', tags: ['auth'], request: req })
    expect(created).toMatchObject({ name: 'login', tags: ['auth'], responses: [] })

    const updated = call<SavedRequest>('repeater:save', {
      id: created.id,
      name: 'login v2',
      tags: ['auth', 'post'],
      request: req
    })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('login v2')
    expect(call<SavedRequest[]>('repeater:list')).toHaveLength(1)

    expect(call<boolean>('repeater:delete', created.id)).toBe(true)
    expect(call<SavedRequest[]>('repeater:list')).toHaveLength(0)
  })

  it('rejects malformed save payloads', () => {
    createRepeater(makeWin(), vi.fn())
    expect(call('repeater:save', null)).toBeNull()
    expect(call('repeater:save', { name: 'x', tags: 'nope', request: req })).toBeNull()
    expect(call('repeater:save', { name: 'x', tags: [], request: { url: 'u' } })).toBeNull()
    expect(call('repeater:save', { id: 'ghost', name: 'x', tags: [], request: req })).toBeNull()
  })

  it('sends through the replayer and appends to response history (capped)', async () => {
    let n = 0
    const replayer: Replayer = vi.fn(async () => ok(`r${n++}`))
    createRepeater(makeWin(), replayer)
    const { id } = call<SavedRequest>('repeater:save', { name: 's', tags: [], request: req })

    for (let i = 0; i < 12; i++) await call<Promise<SavedRequest>>('repeater:send', id)
    const entry = call<SavedRequest[]>('repeater:list')[0]
    expect(replayer).toHaveBeenCalledTimes(12)
    expect(entry.responses).toHaveLength(10) // RESPONSE_HISTORY cap
    expect((entry.responses[9] as { body: string }).body).toBe('r11') // newest kept
  })

  it('diffs the two most recent responses via the 5.E diff tool', async () => {
    let n = 0
    const replayer: Replayer = vi.fn(async () => ok(n++ === 0 ? 'alpha' : 'beta'))
    createRepeater(makeWin(), replayer)
    const { id } = call<SavedRequest>('repeater:save', { name: 's', tags: [], request: req })
    await call<Promise<SavedRequest>>('repeater:send', id)
    await call<Promise<SavedRequest>>('repeater:send', id)

    const diff = call<{ bodyIdentical: boolean } | null>('repeater:diff', { id })
    expect(diff).not.toBeNull()
    expect(diff!.bodyIdentical).toBe(false)
  })

  it('returns null from diff when fewer than two successful responses exist', async () => {
    const replayer: Replayer = vi.fn(async () => ok('only'))
    createRepeater(makeWin(), replayer)
    const { id } = call<SavedRequest>('repeater:save', { name: 's', tags: [], request: req })
    await call<Promise<SavedRequest>>('repeater:send', id)
    expect(call('repeater:diff', { id })).toBeNull()
  })

  it('broadcasts repeater:changed on mutation', () => {
    createRepeater(makeWin(), vi.fn())
    call('repeater:save', { name: 's', tags: [], request: req })
    expect(sent.some((m) => m.channel === 'repeater:changed')).toBe(true)
  })
})
