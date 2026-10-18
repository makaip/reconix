// Traces store (ARCHITECTURE §6.4): opaque evidence blobs — screenshots, captured
// request/response pairs, raw traces — addressed by a `traceRef`, never inlined
// over the bridge by the tools. Per §6.4 the bytes live as files on disk under
// userData/traces and the shared SQLite DB (db.ts) holds only a ref + path, so a
// multi-MB screenshot never bloats the database. get_trace reads them back for
// the agent; the Traces panel reads them over the traces:* IPC.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import type { Database } from 'node-sqlite3-wasm'
import type { TraceDetail, TraceKind, TraceSummary } from '../shared/traces'
import type { TraceRecord, TraceStore } from './mcp/tool'

export interface TraceStoreOptions {
  /** Directory the trace bytes are written to. Created if missing. */
  tracesDir: string
  /** Static engagement id (legacy). Prefer `getEngagementId` for live runs. */
  engagementId?: string | null
  /** Resolver for the current engagement id (live runs). */
  getEngagementId?: () => string | null
}

/** The MCP-facing sink plus the renderer IPC surface over the same table. */
export interface TracesStore {
  /** Sink handed to the MCP tool context (backs screenshot + get_trace). */
  store: TraceStore
  /** Renderer-facing metadata list, newest first. */
  list(): TraceSummary[]
  /** Renderer-facing contents: binary as base64, text as UTF-8. Null if unknown. */
  get(ref: string): TraceDetail | null
  /** Detach the IPC handlers + window listener. Does NOT delete trace files. */
  close(): void
}

/** Refs are `trace_<n>`; recover the sequence so restored refs never collide. */
function refSeq(ref: string): number {
  const match = /^trace_(\d+)$/.exec(ref)
  return match ? Number(match[1]) : 0
}

const validKind = (value: unknown): value is TraceKind =>
  value === 'screenshot' || value === 'reqresp' || value === 'trace'

export function createTraceStore(
  db: Database,
  win: BrowserWindow,
  options: TraceStoreOptions
): TracesStore {
  const { tracesDir, engagementId = null, getEngagementId } = options
  mkdirSync(tracesDir, { recursive: true })

  const resolveEngagementId = (): string | null =>
    getEngagementId ? getEngagementId() : (engagementId ?? null)

  let seq = 0
  for (const row of db.all('SELECT id FROM traces')) {
    seq = Math.max(seq, refSeq(String((row as Record<string, unknown>).id)))
  }

  // A row whose file is gone is treated as unresolvable (null) rather than an
  // error: evidence can be pruned out from under us without breaking the reads.
  const read = (ref: string): TraceRecord | null => {
    const row = db.get('SELECT id, kind, path, ts FROM traces WHERE id = ?', [ref])
    if (!row) return null
    const r = row as Record<string, unknown>
    if (!validKind(r.kind)) return null
    let data: Uint8Array
    try {
      data = readFileSync(String(r.path))
    } catch {
      return null
    }
    return { ref: String(r.id), kind: r.kind, ts: Number(r.ts) || 0, data }
  }

  const list = (): TraceSummary[] =>
    db
      .all('SELECT id, kind, path, ts FROM traces ORDER BY rowid DESC')
      .flatMap((row) => {
        const r = row as Record<string, unknown>
        if (!validKind(r.kind)) return []
        let bytes = 0
        try {
          bytes = statSync(String(r.path)).size
        } catch {
          bytes = 0
        }
        return [{ ref: String(r.id), kind: r.kind, ts: Number(r.ts) || 0, bytes }]
      })

  const detail = (ref: string): TraceDetail | null => {
    const record = read(ref)
    if (!record) return null
    // Screenshots are the only binary kind we store today; text kinds render as-is.
    const binary = record.kind === 'screenshot'
    return {
      ref: record.ref,
      kind: record.kind,
      ts: record.ts,
      bytes: record.data.length,
      encoding: binary ? 'base64' : 'utf8',
      data: Buffer.from(record.data).toString(binary ? 'base64' : 'utf8')
    }
  }

  const broadcast = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('traces:changed', list())
    }
  }

  const store: TraceStore = {
    save: async (kind, data) => {
      const ref = `trace_${++seq}`
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
      const path = join(tracesDir, ref)
      writeFileSync(path, bytes)
      db.run('INSERT INTO traces (id, engagement_id, kind, path, ts) VALUES (?, ?, ?, ?, ?)', [
        ref,
        resolveEngagementId(),
        kind,
        path,
        Date.now()
      ])
      broadcast()
      return ref
    },
    get: read
  }

  ipcMain.removeHandler('traces:list')
  ipcMain.handle('traces:list', (event) => (event.sender === win.webContents ? list() : []))
  ipcMain.removeHandler('traces:get')
  ipcMain.handle('traces:get', (event, ref: unknown) =>
    event.sender === win.webContents && typeof ref === 'string' ? detail(ref) : null
  )

  // Called from stop() and again when the window closes; both paths land here.
  const close = (): void => {
    ipcMain.removeHandler('traces:list')
    ipcMain.removeHandler('traces:get')
  }
  win.on('closed', close)

  return { store, list, get: detail, close }
}
