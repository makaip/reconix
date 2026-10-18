// Findings store (ARCHITECTURE §6.4: findings(id, engagement_id, schema_json,
// evidence_ref, status, ts)). The real SQLite-backed store doesn't exist yet;
// this is a JSON-file stand-in that keeps the same observable contract — record
// appends, the renderer's Findings panel updates live over `findings:changed` —
// plus one thing the in-memory version couldn't do: rows survive a restart.
// Lives outside copilot.ts so the MCP sink and the IPC surface share one source
// of truth instead of a closure-private array.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

/** Ids are `finding_<n>`; recover the sequence so restored ids never collide. */
function idSeq(id: string): number {
  const match = /^finding_(\d+)$/.exec(id)
  return match ? Number(match[1]) : 0
}

/** Loose structural check — a persisted row is untrusted input (the file can be
 *  hand-edited or truncated), so only rows we can actually render are kept. */
function isStoredFinding(value: unknown): value is StoredFinding {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r.id === 'string' && typeof r.evidenceRef === 'string' && typeof r.ts === 'number'
}

/** Best-effort restore. A missing file is the normal first run; a corrupt one is
 *  logged and treated as empty so a bad file never blocks startup (the next
 *  record rewrites it). */
function readStoredFindings(filePath: string): StoredFinding[] {
  if (!existsSync(filePath)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isStoredFinding) : []
  } catch (error) {
    console.error(`Ignoring unreadable findings file at ${filePath}:`, error)
    return []
  }
}

/**
 * @param filePath Where rows persist. Omit for a purely in-memory store (unit
 *   tests exercise the IPC/broadcast path without touching disk).
 */
export function createFindingsStore(win: BrowserWindow, filePath?: string): FindingsStore {
  const rows: StoredFinding[] = []
  let seq = 0

  // Restore before anything can record, so a restart continues the id sequence
  // instead of overwriting finding_1.
  for (const row of filePath ? readStoredFindings(filePath) : []) {
    rows.push(row)
    seq = Math.max(seq, idSeq(row.id))
  }

  // Findings are low-volume and only written when one is recorded, so a sync
  // atomic swap (temp + rename) is simpler than a write queue and can't leave a
  // half-written file behind if the app dies mid-write.
  const persist = (): void => {
    if (!filePath) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(rows))
      renameSync(tmp, filePath)
    } catch (error) {
      console.error('Failed to persist findings:', error)
    }
  }

  const broadcast = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('findings:changed', summarize(rows))
    }
  }

  const sink: FindingSink = {
    record: async (schema, evidenceRef) => {
      const id = `finding_${++seq}`
      rows.push({ id, schema, evidenceRef, ts: Date.now() })
      persist()
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
