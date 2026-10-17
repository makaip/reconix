import { BrowserWindow, ipcMain } from 'electron'
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

/**
 * Repeater's saved-request store (ARCHITECTURE.MD §11.1): create/edit/tag/delete
 * requests and resend them through the SAME gated replayer the replay:send IPC uses,
 * so every send is scope- and rate-checked identically. Holds recent response history
 * per request for the diff view. In-memory, per session (no persistence yet).
 */
export function createRepeater(win: BrowserWindow, replayer: Replayer): Repeater {
  // Insertion-ordered; oldest evicted once over MAX_SAVED.
  const saved = new Map<string, SavedRequest>()

  const list = (): SavedRequest[] => [...saved.values()]

  const broadcast = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('repeater:changed', list())
    }
  }

  const save = (raw: unknown): SavedRequest | null => {
    const input = normalizeSave(raw)
    if (!input) return null
    if (input.id) {
      const existing = saved.get(input.id)
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
    saved.set(created.id, created)
    while (saved.size > MAX_SAVED) {
      const oldest = saved.keys().next().value
      if (oldest === undefined) break
      saved.delete(oldest)
    }
    broadcast()
    return created
  }

  const remove = (id: unknown): boolean => {
    if (typeof id !== 'string') return false
    const had = saved.delete(id)
    if (had) broadcast()
    return had
  }

  const run = async (id: unknown): Promise<SavedRequest | null> => {
    if (typeof id !== 'string') return null
    const entry = saved.get(id)
    if (!entry) return null
    const result = await replayer(entry.request)
    entry.responses.push(result)
    if (entry.responses.length > RESPONSE_HISTORY) entry.responses.shift()
    entry.updatedAt = Date.now()
    broadcast()
    return entry
  }

  // Compares two responses of a saved request via the 5.E diff tool. Indices default
  // to the two most recent. Returns null when either index has no successful response.
  const diff = (raw: unknown): unknown => {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as { id?: unknown; aIndex?: unknown; bIndex?: unknown }
    if (typeof r.id !== 'string') return null
    const entry = saved.get(r.id)
    if (!entry) return null
    const n = entry.responses.length
    const ai = typeof r.aIndex === 'number' ? r.aIndex : n - 2
    const bi = typeof r.bIndex === 'number' ? r.bIndex : n - 1
    const a = toResponseLike(entry.responses[ai])
    const b = toResponseLike(entry.responses[bi])
    if (!a || !b) return null
    return invokeTool(diffResponsesTool, { a, b })
  }

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) =>
      event.sender === win.webContents ? fn(...args) : null
    )
  }
  handle('repeater:list', () => list())
  handle('repeater:save', (payload) => save(payload))
  handle('repeater:delete', (id) => remove(id))
  handle('repeater:send', (id) => run(id))
  handle('repeater:diff', (payload) => diff(payload))

  const channels = ['repeater:list', 'repeater:save', 'repeater:delete', 'repeater:send', 'repeater:diff']
  const close = (): void => {
    for (const c of channels) ipcMain.removeHandler(c)
  }
  win.on('closed', close)
  return { close }
}
