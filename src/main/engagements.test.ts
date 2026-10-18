import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []
const sender = {
  id: 1,
  isDestroyed: () => false,
  send: (channel: string, payload: unknown) => {
    sent.push({ channel, payload })
  }
}
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, (...args: unknown[]) => fn({ sender }, ...args)),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

import { openDatabase } from './db'
import { createEngagementStore } from './engagements'

const makeWin = (): BrowserWindow =>
  ({ webContents: sender, isDestroyed: () => false, on: () => undefined }) as unknown as BrowserWindow

beforeEach(() => {
  handlers.clear()
  sent.length = 0
})

describe('createEngagementStore', () => {
  it('starts an engagement and reports it as current', () => {
    const store = createEngagementStore(openDatabase(), makeWin(), { defaultPolicy: { autoApprove: [] } })
    const row = store.start({ goal: 'recon app.local', scope: { engagementId: 'eng_1' }, policy: { autoApprove: ['R'] } })

    expect(row.id).toBe('eng_1')
    expect(row.status).toBe('active')
    expect(row.goal).toBe('recon app.local')
    expect(store.current()).toMatchObject({ id: 'eng_1', status: 'active' })
    expect(store.currentId()).toBe('eng_1')
    expect(store.list()).toHaveLength(1)
    expect(sent.at(-1)?.channel).toBe('engagement:changed')
  })

  it('stops the active engagement', () => {
    const store = createEngagementStore(openDatabase(), makeWin())
    store.start({ goal: 'g', scope: { engagementId: 'eng_2' }, policy: null })

    store.stop()
    const row = store.get('eng_2')!
    expect(row.status).toBe('stopped')
    expect(row.stoppedAt).not.toBeNull()
    expect(store.current()).toBeNull()
    // falls back to null when no scope.json id is available
  })

  it('replaces an active engagement when a new one starts', () => {
    const store = createEngagementStore(openDatabase(), makeWin())
    store.start({ goal: 'first', scope: { engagementId: 'eng_a' }, policy: null })
    store.start({ goal: 'second', scope: { engagementId: 'eng_b' }, policy: null })

    expect(store.current()?.id).toBe('eng_b')
    expect(store.get('eng_a')?.status).toBe('stopped')
    expect(store.list()).toHaveLength(2)
  })

  it('serves engagement:get/current/list to the owning window', () => {
    const store = createEngagementStore(openDatabase(), makeWin())
    store.start({ goal: 'g', scope: { engagementId: 'eng_3' }, policy: null })

    expect(handlers.get('engagement:get')!()).toBe('eng_3')
    expect(handlers.get('engagement:current')!()).toMatchObject({ id: 'eng_3' })
    expect(handlers.get('engagement:list')!()).toHaveLength(1)
  })
})
