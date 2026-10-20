import { BrowserWindow, ipcMain } from 'electron'
import { Database } from 'node-sqlite3-wasm'
import type { ResponseLike } from '../shared/tools'
import type { ReplayResult, SaveRequestInput, SavedRequest } from '../shared/tabs'
import { diffResponsesTool } from '../tools/diffResponses'
import { invokeTool } from '../shared/tools'
import type { Replayer } from './replay'

const MAX_SAVED = 200
const RESPONSE_HISTORY = 10 // enough to compare recent sends
const MAX_NAME = 200
const MAX_TAGS = 20
const MAX_TAG_LEN = 60

export type Repeater = { close: () => void }

export interface RepeaterCoreOptions {
  db?: Database | null
}

let seq = 1
const newId = (): string => `rep-${Date.now().toString(36)}-${seq++}`

/** Coerces a saved request's success result to the diff tool's ResponseLike shape. */
function toResponseLike(result: ReplayResult | undefined): ResponseLike | null {
  if (!result || !result.ok) return null
  return { status: result.status, body: result.body, timingMs: result.timingMs, headers: result.headers }
}

/** Normalizes a save payload. Input is trusted (own renderer) but still bounded. */
function normalizeSave(raw: unknown): SaveRequestInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || r.name.length > MAX_NAME) return null
  if (!Array.isArray(r.tags)) return null
  const tags = r.tags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.slice(0, MAX_TAG_LEN))
    .slice(0, MAX_TAGS)
  if (typeof r.request !== 'object' || r.request === null) return null
  const req = r.request as Record<string, unknown>
  if (typeof req.method !== 'string' || typeof req.url !== 'string') return null
  // Pass request through as-is; the replayer re-validates every field before any send.
  return {
    id: typeof r.id === 'string' ? r.id : undefined,
    name: r.name,
    tags,
    request: req as SaveRequestInput['request']
  }
}

function rowToSaved(row: Record<string, unknown>): SavedRequest | null {
  try {
    const id = String(row.id)
    const name = String(row.name)
    const tags = JSON.parse(String(row.tags_json ?? '[]'))
    const request = JSON.parse(String(row.request_json))
    const responses = JSON.parse(String(row.responses_json ?? '[]'))
    return {
      id,
      name,
      tags: Array.isArray(tags) ? tags : [],
      request,
      responses: Array.isArray(responses) ? responses : [],
      updatedAt: Number(row.updated_at) || Date.now()
    }
  } catch {
    return null
  }
}

/** Reusable, window-independent repeater store + send core. */
export interface RepeaterCore {
  list(): SavedRequest[]
  save(raw: unknown): SavedRequest | null
  remove(id: unknown): boolean
  run(id: unknown): Promise<SavedRequest | null>
  diff(raw: unknown): unknown
  onUpdate(cb: (items: SavedRequest[]) => void): void
}

export function createRepeaterCore(replayer: Replayer, opts: RepeaterCoreOptions = {}): RepeaterCore {
  const db = opts.db ?? null
  const useDb = db !== null

  // In-memory fallback map (used when no DB).
  const memSaved = new Map<string, SavedRequest>()

  // Restore seq from existing rows so restarts never reuse an id.
  if (useDb && db) {
    for (const row of db.all('SELECT id FROM repeater_saved')) {
      const m = /^rep-[0-9a-z]+-(\d+)$/.exec(String((row as Record<string, unknown>).id))
      if (m) seq = Math.max(seq, Number(m[1]) + 1)
    }
  }

  const list = (): SavedRequest[] => {
    if (useDb && db) {
      const rows = db.all('SELECT * FROM repeater_saved ORDER BY rowid') as Record<string, unknown>[]
      const out: SavedRequest[] = []
      for (const r of rows) {
        const s = rowToSaved(r)
        if (s) out.push(s)
      }
      return out
    }
    return [...memSaved.values()]
  }

  let listener: ((items: SavedRequest[]) => void) | undefined
  const broadcast = (): void => {
    listener?.(list())
  }

  const save = (raw: unknown): SavedRequest | null => {
    const input = normalizeSave(raw)
    if (!input) return null
    if (input.id) {
      if (useDb && db) {
        const rows = db.all('SELECT * FROM repeater_saved WHERE id = ?', [input.id]) as Record<string, unknown>[]
        if (rows.length === 0) return null
        const existing = rowToSaved(rows[0])
        if (!existing) return null
        db.run('UPDATE repeater_saved SET name=?, tags_json=?, request_json=?, updated_at=? WHERE id=?', [
          input.name,
          JSON.stringify(input.tags),
          JSON.stringify(input.request),
          Date.now(),
          input.id
        ])
        broadcast()
        return { ...existing, name: input.name, tags: input.tags, request: input.request, updatedAt: Date.now() }
      }
      const existing = memSaved.get(input.id)
      if (!existing) return null
      existing.name = input.name
      existing.tags = input.tags
      existing.request = input.request
      existing.updatedAt = Date.now()
      broadcast()
      return existing
    }
    const created: SavedRequest = {
      id: newId(),
      name: input.name,
      tags: input.tags,
      request: input.request,
      responses: [],
      updatedAt: Date.now()
    }
    if (useDb && db) {
      db.run('INSERT INTO repeater_saved (id, name, tags_json, request_json, responses_json, updated_at) VALUES (?,?,?,?,?,?)', [
        created.id,
        created.name,
        JSON.stringify(created.tags),
        JSON.stringify(created.request),
        '[]',
        created.updatedAt
      ])
      // Evict oldest once over MAX_SAVED
      const count = (db.all('SELECT COUNT(*) AS c FROM repeater_saved')[0] as { c: number }).c
      if (count > MAX_SAVED) {
        const oldest = db.all('SELECT id FROM repeater_saved ORDER BY rowid LIMIT ?', [count - MAX_SAVED]) as { id: string }[]
        for (const o of oldest) db.run('DELETE FROM repeater_saved WHERE id = ?', [o.id])
      }
    } else {
      memSaved.set(created.id, created)
      while (memSaved.size > MAX_SAVED) {
        const oldest = memSaved.keys().next().value
        if (oldest === undefined) break
        memSaved.delete(oldest)
      }
    }
    broadcast()
    return created
  }

  const remove = (id: unknown): boolean => {
    if (typeof id !== 'string') return false
    if (useDb && db) {
      const rows = db.all('SELECT id FROM repeater_saved WHERE id = ?', [id]) as { id: string }[]
      if (rows.length === 0) return false
      db.run('DELETE FROM repeater_saved WHERE id = ?', [id])
      broadcast()
      return true
    }
    const had = memSaved.delete(id)
    if (had) broadcast()
    return had
  }

  const run = async (id: unknown): Promise<SavedRequest | null> => {
    if (typeof id !== 'string') return null
    if (useDb && db) {
      const rows = db.all('SELECT * FROM repeater_saved WHERE id = ?', [id]) as Record<string, unknown>[]
      if (rows.length === 0) return null
      const entry = rowToSaved(rows[0])
      if (!entry) return null
      const result = await replayer(entry.request)
      entry.responses.push(result)
      if (entry.responses.length > RESPONSE_HISTORY) entry.responses.shift()
      entry.updatedAt = Date.now()
      db.run('UPDATE repeater_saved SET responses_json=?, updated_at=? WHERE id=?', [
        JSON.stringify(entry.responses),
        entry.updatedAt,
        id
      ])
      broadcast()
      return entry
    }
    const entry = memSaved.get(id)
    if (!entry) return null
    const result = await replayer(entry.request)
    entry.responses.push(result)
    if (entry.responses.length > RESPONSE_HISTORY) entry.responses.shift()
    entry.updatedAt = Date.now()
    broadcast()
    return entry
  }

  const diff = (raw: unknown): unknown => {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as { id?: unknown; aIndex?: unknown; bIndex?: unknown }
    if (typeof r.id !== 'string') return null
    const entry = (useDb && db
      ? (db.all('SELECT * FROM repeater_saved WHERE id = ?', [r.id]) as Record<string, unknown>[]).map(rowToSaved).find(Boolean)
      : memSaved.get(r.id)) as SavedRequest | undefined
    if (!entry) return null
    const n = entry.responses.length
    const ai = typeof r.aIndex === 'number' ? r.aIndex : n - 2
    const bi = typeof r.bIndex === 'number' ? r.bIndex : n - 1
    const a = toResponseLike(entry.responses[ai])
    const b = toResponseLike(entry.responses[bi])
    if (!a || !b) return null
    return invokeTool(diffResponsesTool, { a, b })
  }

  return {
    list,
    save,
    remove,
    run,
    diff,
    onUpdate: (cb) => {
      listener = cb
    }
  }
}

/** Window/IPC wrapper around the reusable repeater core. */
export function createRepeater(win: BrowserWindow, replayer: Replayer, existingCore?: RepeaterCore): Repeater {
  const core = existingCore ?? createRepeaterCore(replayer)

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) =>
      event.sender === win.webContents ? fn(...args) : null
    )
  }
  handle('repeater:list', () => core.list())
  handle('repeater:save', (payload) => core.save(payload))
  handle('repeater:delete', (id) => core.remove(id))
  handle('repeater:send', (id) => core.run(id))
  handle('repeater:diff', (payload) => core.diff(payload))
  core.onUpdate((items) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('repeater:changed', items)
    }
  })

  const channels = ['repeater:list', 'repeater:save', 'repeater:delete', 'repeater:send', 'repeater:diff']
  const close = (): void => {
    for (const c of channels) ipcMain.removeHandler(c)
  }
  win.on('closed', close)
  return { close }
}
