import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

import { openDatabase } from './db'
import { createFindingsStore } from './findings'

const makeWin = (): BrowserWindow =>
  ({ webContents: sender, isDestroyed: () => false, on: () => undefined }) as unknown as BrowserWindow

beforeEach(() => {
  handlers.clear()
  sent.length = 0
})

describe('createFindingsStore', () => {
  it('summarizes a recorded finding and broadcasts the change', async () => {
    const store = createFindingsStore(openDatabase(), makeWin())
    const id = await store.sink.record({ title: 'Reflected XSS', severity: 'high' }, 'trace_1')

    expect(id).toBe('finding_1')
    expect(store.summary()).toEqual([{ id: 'finding_1', title: 'Reflected XSS', severity: 'high' }])
    expect(sent.at(-1)).toEqual({
      channel: 'findings:changed',
      payload: [{ id: 'finding_1', title: 'Reflected XSS', severity: 'high' }]
    })
  })

  it('keeps the raw schema + evidence ref for query_log/history', async () => {
    const store = createFindingsStore(openDatabase(), makeWin())
    await store.sink.record({ title: 'x', severity: 'low' }, 'trace_9')

    expect(store.list()).toMatchObject([
      { id: 'finding_1', schema: { title: 'x', severity: 'low' }, evidenceRef: 'trace_9' }
    ])
  })

  it('degrades an unknown severity to info and falls back on the title', async () => {
    const store = createFindingsStore(openDatabase(), makeWin())
    await store.sink.record({ severity: 'urgent' }, 'trace_2')

    expect(store.summary()).toEqual([{ id: 'finding_1', title: 'Finding finding_1', severity: 'info' }])
  })

  it('serves findings:list to the owning window', async () => {
    const store = createFindingsStore(openDatabase(), makeWin())
    await store.sink.record({ title: 'a', severity: 'critical' }, 't')

    expect(handlers.get('findings:list')!()).toEqual([
      { id: 'finding_1', title: 'a', severity: 'critical' }
    ])
  })
})

describe('createFindingsStore persistence', () => {
  const tempFile = (): string =>
    join(mkdtempSync(join(tmpdir(), 'reconix-findings-')), 'reconix.db')

  it('restores persisted rows and continues the id sequence across restarts', async () => {
    const file = tempFile()
    const firstDb = openDatabase(file)
    const first = createFindingsStore(firstDb, makeWin())
    await first.sink.record({ title: 'Reflected XSS', severity: 'high' }, 'trace_1')
    firstDb.close()

    const secondDb = openDatabase(file)
    const second = createFindingsStore(secondDb, makeWin())
    expect(second.summary()).toEqual([
      { id: 'finding_1', title: 'Reflected XSS', severity: 'high' }
    ])
    expect(second.list()).toMatchObject([{ evidenceRef: 'trace_1' }])

    // seq was recovered, so the next id doesn't collide with the restored one
    expect(await second.sink.record({ title: 'SSRF', severity: 'medium' }, 'trace_2')).toBe(
      'finding_2'
    )
    secondDb.close()
  })

  it('stamps the engagement id and default status from the §6.4 schema', async () => {
    const db = openDatabase(tempFile())
    const store = createFindingsStore(db, makeWin(), { engagementId: 'eng_42' })
    await store.sink.record({ title: 'x', severity: 'low' }, 't')

    const row = db.get('SELECT engagement_id, status FROM findings') as {
      engagement_id: string
      status: string
    }
    expect(row.engagement_id).toBe('eng_42')
    expect(row.status).toBe('open')
    db.close()
  })
})
