import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

// ipcMain.handle/removeHandler fire at store construction; capture handlers so
// we can drive findings:list, and capture webContents.send for the broadcast.
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

import { createFindingsStore } from './findings'

const makeWin = (): BrowserWindow =>
  ({ webContents: sender, isDestroyed: () => false, on: () => undefined }) as unknown as BrowserWindow

beforeEach(() => {
  handlers.clear()
  sent.length = 0
})

describe('createFindingsStore', () => {
  it('summarizes a recorded finding and broadcasts the change', async () => {
    const store = createFindingsStore(makeWin())
    const id = await store.sink.record({ title: 'Reflected XSS', severity: 'high' }, 'trace_1')

    expect(id).toBe('finding_1')
    expect(store.summary()).toEqual([{ id: 'finding_1', title: 'Reflected XSS', severity: 'high' }])
    expect(sent.at(-1)).toEqual({
      channel: 'findings:changed',
      payload: [{ id: 'finding_1', title: 'Reflected XSS', severity: 'high' }]
    })
  })

  it('keeps the raw schema + evidence ref for query_log/history', async () => {
    const store = createFindingsStore(makeWin())
    await store.sink.record({ title: 'x', severity: 'low' }, 'trace_9')

    expect(store.list()).toMatchObject([
      { id: 'finding_1', schema: { title: 'x', severity: 'low' }, evidenceRef: 'trace_9' }
    ])
  })

  it('degrades an unknown severity to info and falls back on the title', async () => {
    const store = createFindingsStore(makeWin())
    await store.sink.record({ severity: 'urgent' }, 'trace_2')

    expect(store.summary()).toEqual([{ id: 'finding_1', title: 'Finding finding_1', severity: 'info' }])
  })

  it('serves findings:list to the owning window', async () => {
    const store = createFindingsStore(makeWin())
    await store.sink.record({ title: 'a', severity: 'critical' }, 't')

    expect(handlers.get('findings:list')!()).toEqual([
      { id: 'finding_1', title: 'a', severity: 'critical' }
    ])
  })
})
