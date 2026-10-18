// Findings store (ARCHITECTURE §6.4: findings(id, engagement_id, schema_json,
// evidence_ref, status, ts)). Rows live in the shared SQLite database (db.ts) —
// see that module for the driver rationale. Same observable contract as the
// in-memory original: record appends, the renderer's Findings panel updates live
// over `findings:changed`. Lives outside copilot.ts so the MCP sink and the IPC
// surface share one source of truth instead of a closure-private array.
import type { Database } from 'node-sqlite3-wasm'
import { ipcMain, type BrowserWindow } from 'electron'
import type { Finding, FindingSeverity } from '../shared/findings'
import type { FindingSink } from './mcp/tool'

/** One stored row: the agent's opaque schema plus its evidence ref. */
export interface StoredFinding {
  id: string
  schema: unknown
  evidenceRef: string
  ts: number
}

export interface FindingsStore {
  /** Sink handed to the MCP tool context (backs record_finding). */
  sink: FindingSink
  /** Full stored rows, insertion order (backs query_log / history). */
  list(): StoredFinding[]
  /** Renderer-facing summary rows. */
  summary(): Finding[]
  /** Detach the IPC handler + window listener. Does NOT close the shared DB. */
  close(): void
}

export interface FindingsStoreOptions {
  /** Static engagement id (legacy callers). Prefer `getEngagementId` for live runs. */
  engagementId?: string | null
  /** Resolver for the current engagement id (live runs). */
  getEngagementId?: () => string | null
}

const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info']

/** record_finding's schema is agent-authored and opaque, so the display fields
 *  are read defensively: an unrecognized severity degrades to 'info' rather
 *  than mislabeling a finding. */
function asSeverity(value: unknown): FindingSeverity {
  if (typeof value === 'string') {
    const v = value.toLowerCase()
    if ((SEVERITIES as readonly string[]).includes(v)) return v as FindingSeverity
  }
  return 'info'
}

function asTitle(schema: unknown, id: string): string {
  if (schema && typeof schema === 'object') {
    const s = schema as Record<string, unknown>
    for (const key of ['title', 'name', 'summary']) {
      const v = s[key]
      if (typeof v === 'string' && v.trim()) return v
    }
  }
  return `Finding ${id}`
}

/** StoredFinding -> display row. Exported so the history reader renders findings
 *  identically (one definition of title/severity). */
export function findingSummary(row: StoredFinding): Finding {
  const schema = (row.schema ?? {}) as Record<string, unknown>
  return { id: row.id, title: asTitle(row.schema, row.id), severity: asSeverity(schema.severity) }
}

/** Ids are `finding_<n>`; recover the sequence so restored ids never collide. */
function idSeq(id: string): number {
  const match = /^finding_(\d+)$/.exec(id)
  return match ? Number(match[1]) : 0
}

/** schema_json is round-tripped through the agent's opaque schema; a row we
 *  can't parse degrades to an empty object rather than failing the whole read. */
function parseSchema(json: unknown): unknown {
  try {
    return JSON.parse(String(json))
  } catch {
    return {}
  }
}

function toStored(row: Record<string, unknown>): StoredFinding {
  return {
    id: String(row.id),
    schema: parseSchema(row.schema_json),
    evidenceRef: typeof row.evidence_ref === 'string' ? row.evidence_ref : '',
    ts: Number(row.ts) || 0
  }
}

export function createFindingsStore(
  db: Database,
  win: BrowserWindow,
  options: FindingsStoreOptions = {}
): FindingsStore {
  const { engagementId = null, getEngagementId } = options
  const resolveEngagementId = (): string | null =>
    getEngagementId ? getEngagementId() : (engagementId ?? null)

  // Restore the id sequence so a restart continues it instead of colliding with
  // an existing PRIMARY KEY.
  let seq = 0
  for (const row of db.all('SELECT id FROM findings')) {
    seq = Math.max(seq, idSeq(String((row as Record<string, unknown>).id)))
  }

  const readAll = (): StoredFinding[] =>
    db
      .all('SELECT id, schema_json, evidence_ref, ts FROM findings ORDER BY rowid')
      .map((row) => toStored(row as Record<string, unknown>))

  const broadcast = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('findings:changed', readAll().map(findingSummary))
    }
  }

  const sink: FindingSink = {
    record: async (schema, evidenceRef) => {
      const id = `finding_${++seq}`
      db.run(
        'INSERT INTO findings (id, engagement_id, schema_json, evidence_ref, ts) VALUES (?, ?, ?, ?, ?)',
        [id, resolveEngagementId(), JSON.stringify(schema ?? null), evidenceRef, Date.now()]
      )
      broadcast()
      return id
    }
  }

  ipcMain.removeHandler('findings:list')
  ipcMain.handle('findings:list', (event) =>
    event.sender === win.webContents ? readAll().map(findingSummary) : []
  )

  // Called from stop() and again when the window closes; both paths land here.
  const close = (): void => {
    ipcMain.removeHandler('findings:list')
  }
  win.on('closed', close)

  return { sink, list: readAll, summary: () => readAll().map(findingSummary), close }
}
