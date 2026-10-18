// Traces store (ARCHITECTURE §6.4): opaque evidence blobs — screenshots, captured
// request/response pairs, raw traces — addressed by a `traceRef`, never inlined
// over the bridge by the tools. Bytes live in the shared SQLite DB (db.ts); text
// traces are stored as UTF-8 bytes, screenshots as PNG bytes. get_trace reads
// them back for the agent; the Traces panel reads them over the traces:* IPC.
import { ipcMain, type BrowserWindow } from 'electron'
import type { Database } from 'node-sqlite3-wasm'
import type { TraceDetail, TraceKind, TraceSummary } from '../shared/traces'
import type { TraceRecord, TraceStore } from './mcp/tool'

export interface TraceStoreOptions {
  /** Engagement these traces belong to; null when no scope is loaded. */
  engagementId?: string | null
}

/** The MCP-facing sink plus the renderer IPC surface over the same table. */
export interface TracesStore {
  /** Sink handed to the MCP tool context (backs screenshot + get_trace). */
  store: TraceStore
  /** Renderer-facing metadata list, newest first. */
  list(): TraceSummary[]
  /** Renderer-facing contents: binary as base64, text as UTF-8. Null if unknown. */
  get(ref: string): TraceDetail | null
  /** Detach the IPC handlers + window listener. Does NOT close the shared DB. */
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
  options: TraceStoreOptions = {}
): TracesStore {
  const { engagementId = null } = options

  let seq = 0
  for (const row of db.all('SELECT ref FROM traces')) {
    seq = Math.max(seq, refSeq(String((row as Record<string, unknown>).ref)))
  }

  const read = (ref: string): TraceRecord | null => {
    const row = db.get('SELECT ref, kind, data, ts FROM traces WHERE ref = ?', [ref])
    if (!row) return null
    const r = row as Record<string, unknown>
    if (!validKind(r.kind)) return null
    return {
      ref: String(r.ref),
      kind: r.kind,
      ts: Number(r.ts) || 0,
      data: r.data instanceof Uint8Array ? r.data : Buffer.from(String(r.data ?? ''), 'utf8')
    }
  }

  const list = (): TraceSummary[] =>
    db
      .all('SELECT ref, kind, ts, length(data) AS bytes FROM traces ORDER BY rowid DESC')
      .flatMap((row) => {
        const r = row as Record<string, unknown>
        return validKind(r.kind)
          ? [{ ref: String(r.ref), kind: r.kind, ts: Number(r.ts) || 0, bytes: Number(r.bytes) || 0 }]
          : []
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
      db.run('INSERT INTO traces (ref, engagement_id, kind, data, ts) VALUES (?, ?, ?, ?, ?)', [
        ref,
        engagementId,
        kind,
        bytes,
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
