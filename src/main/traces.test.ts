import { describe, expect, it, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'reconix-traces-'))
const openIn = (dir: string): ReturnType<typeof openDatabase> => openDatabase(join(dir, 'reconix.db'))

beforeEach(() => {
  handlers.clear()
  sent.length = 0
})

describe('createTraceStore', () => {
  it('writes trace bytes to disk and reads them back', async () => {
    const dir = tempRoot()
    const traces = createTraceStore(openDatabase(), makeWin(), { tracesDir: dir })
    const ref = await traces.store.save('trace', 'hello world')

    expect(ref).toBe('trace_1')
    expect(existsSync(join(dir, 'trace_1'))).toBe(true)
    const record = traces.store.get(ref)!
    expect(record).toMatchObject({ ref, kind: 'trace' })
    expect(Buffer.from(record.data).toString('utf8')).toBe('hello world')
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips binary bytes exactly', async () => {
    const dir = tempRoot()
    const traces = createTraceStore(openDatabase(), makeWin(), { tracesDir: dir })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ref = await traces.store.save('screenshot', png)

    expect(Buffer.compare(Buffer.from(traces.store.get(ref)!.data), png)).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for an unknown ref', () => {
    const dir = tempRoot()
    const traces = createTraceStore(openDatabase(), makeWin(), { tracesDir: dir })
    expect(traces.store.get('trace_999')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exposes a metadata list, newest first, and a renderer detail', async () => {
    const dir = tempRoot()
    const traces = createTraceStore(openDatabase(), makeWin(), { tracesDir: dir })
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
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats a missing file as unresolvable', async () => {
    const dir = tempRoot()
    const traces = createTraceStore(openDatabase(), makeWin(), { tracesDir: dir })
    const ref = await traces.store.save('screenshot', Buffer.from([1, 2, 3]))
    rmSync(join(dir, ref))

    expect(traces.store.get(ref)).toBeNull()
    expect(traces.list()[0]).toMatchObject({ ref, bytes: 0 }) // still listed
    rmSync(dir, { recursive: true, force: true })
  })

  it('pushes traces:changed after a save and serves traces:list to the owner', async () => {
    const dir = tempRoot()
    const traces = createTraceStore(openDatabase(), makeWin(), { tracesDir: dir })
    await traces.store.save('trace', 'x')

    expect(sent.at(-1)).toMatchObject({ channel: 'traces:changed' })
    expect(handlers.get('traces:list')!()).toEqual([
      { ref: 'trace_1', kind: 'trace', ts: expect.any(Number), bytes: 1 }
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it('continues the ref sequence across restarts', async () => {
    const dir = tempRoot()
    const firstDb = openIn(dir)
    await createTraceStore(firstDb, makeWin(), { tracesDir: dir }).store.save('trace', 'a')
    firstDb.close()

    const secondDb = openIn(dir)
    const traces = createTraceStore(secondDb, makeWin(), { tracesDir: dir })
    expect(await traces.store.save('trace', 'b')).toBe('trace_2')
    expect(traces.store.get('trace_1')).not.toBeNull()
    secondDb.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
