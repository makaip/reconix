import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

// ipcMain.handle/removeHandler fire at store construction; capture handlers so we
// can drive traces:list/get, and capture webContents.send for the push.
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
import { createTraceStore } from './traces'

const makeWin = (): BrowserWindow =>
  ({ webContents: sender, isDestroyed: () => false, on: () => undefined }) as unknown as BrowserWindow

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'reconix-traces-')), 'reconix.db')

beforeEach(() => {
  handlers.clear()
  sent.length = 0
})

describe('createTraceStore', () => {
  it('saves a text trace and reads it back', async () => {
    const traces = createTraceStore(openDatabase(), makeWin())
    const ref = await traces.store.save('trace', 'hello world')

    expect(ref).toBe('trace_1')
    const record = traces.store.get(ref)!
    expect(record).toMatchObject({ ref, kind: 'trace' })
    expect(Buffer.from(record.data).toString('utf8')).toBe('hello world')
  })

  it('round-trips binary bytes exactly', async () => {
    const traces = createTraceStore(openDatabase(), makeWin())
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ref = await traces.store.save('screenshot', png)

    expect(Buffer.compare(Buffer.from(traces.store.get(ref)!.data), png)).toBe(0)
  })

  it('returns null for an unknown ref', () => {
    expect(createTraceStore(openDatabase(), makeWin()).store.get('trace_999')).toBeNull()
  })

  it('exposes a metadata list, newest first, and a renderer detail', async () => {
    const traces = createTraceStore(openDatabase(), makeWin())
    await traces.store.save('trace', 'first')
    const png = Buffer.from([1, 2, 3, 4])
    const shot = await traces.store.save('screenshot', png)

    const listed = traces.list()
    expect(listed.map((t) => t.ref)).toEqual([shot, 'trace_1'])
    expect(listed[0]).toMatchObject({ kind: 'screenshot', bytes: 4 })

    expect(traces.get(shot)).toMatchObject({
      kind: 'screenshot',
      encoding: 'base64',
      data: png.toString('base64')
    })
    expect(traces.get('trace_1')).toMatchObject({ encoding: 'utf8', data: 'first' })
    expect(traces.get('trace_999')).toBeNull()
  })

  it('pushes traces:changed after a save and serves traces:list to the owner', async () => {
    const traces = createTraceStore(openDatabase(), makeWin())
    await traces.store.save('trace', 'x')

    expect(sent.at(-1)).toMatchObject({ channel: 'traces:changed' })
    expect(handlers.get('traces:list')!()).toEqual([
      { ref: 'trace_1', kind: 'trace', ts: expect.any(Number), bytes: 1 }
    ])
  })

  it('continues the ref sequence across restarts', async () => {
    const file = tempFile()
    const firstDb = openDatabase(file)
    await createTraceStore(firstDb, makeWin()).store.save('trace', 'a')
    firstDb.close()

    const secondDb = openDatabase(file)
    const traces = createTraceStore(secondDb, makeWin())
    expect(await traces.store.save('trace', 'b')).toBe('trace_2')
    expect(traces.store.get('trace_1')).not.toBeNull()
    secondDb.close()
  })
})
