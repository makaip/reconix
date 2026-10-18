// Findings store (ARCHITECTURE §6.4: findings(id, engagement_id, schema_json,
// evidence_ref, status, ts)). The real SQLite-backed store doesn't exist yet,
// so this is an in-memory stand-in — but unlike the sink it replaces, it is
// observable: record_finding appends, and the renderer's Findings panel updates
// live over `findings:changed`. Lives outside copilot.ts so the MCP sink and the
// IPC surface share one source of truth instead of a closure-private array.
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
  close(): void
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

const summarize = (rows: readonly StoredFinding[]): Finding[] =>
  rows.map((r) => {
    const schema = (r.schema ?? {}) as Record<string, unknown>
    return { id: r.id, title: asTitle(r.schema, r.id), severity: asSeverity(schema.severity) }
  })

export function createFindingsStore(win: BrowserWindow): FindingsStore {
  let seq = 0
  const rows: StoredFinding[] = []

  const broadcast = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('findings:changed', summarize(rows))
    }
  }

  const sink: FindingSink = {
    record: async (schema, evidenceRef) => {
      const id = `finding_${++seq}`
      rows.push({ id, schema, evidenceRef, ts: Date.now() })
      broadcast()
      return id
    }
  }

  ipcMain.removeHandler('findings:list')
  ipcMain.handle('findings:list', (event) =>
    event.sender === win.webContents ? summarize(rows) : []
  )

  const close = (): void => {
    ipcMain.removeHandler('findings:list')
  }
  win.on('closed', close)

  return { sink, list: () => [...rows], summary: () => summarize(rows), close }
}
