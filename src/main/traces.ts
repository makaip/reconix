// Trace store (ARCHITECTURE §6.4): opaque evidence blobs — screenshots, captured
// request/response pairs — addressed by a `traceRef`, never inlined over the
// bridge. Bytes live in the shared SQLite DB (db.ts); text traces are stored as
// UTF-8 bytes, screenshots as PNG bytes. get_trace reads them back.
import type { Database } from 'node-sqlite3-wasm'
import type { TraceKind, TraceRecord, TraceStore } from './mcp/tool'

export interface TraceStoreOptions {
  /** Engagement these traces belong to; null when no scope is loaded. */
  engagementId?: string | null
}

/** Refs are `trace_<n>`; recover the sequence so restored refs never collide. */
function refSeq(ref: string): number {
  const match = /^trace_(\d+)$/.exec(ref)
  return match ? Number(match[1]) : 0
}

const validKind = (value: unknown): value is TraceKind =>
  value === 'screenshot' || value === 'reqresp' || value === 'trace'

export function createTraceStore(db: Database, options: TraceStoreOptions = {}): TraceStore {
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

  return {
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
      return ref
    },
    get: read
  }
}
