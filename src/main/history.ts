// History reader (ARCHITECTURE §6.4) — backs query_log, the agent's only history
// access. Reads the persisted engagement log: recorded findings, tool calls, and
// human approval decisions, merged newest-first. Structured and narrow — never a
// DB handle. Filter keys are read defensively; anything unrecognized is ignored.
import type { Database } from 'node-sqlite3-wasm'
import type { FindingSeverity } from '../shared/findings'
import { findingSummary, type FindingsStore } from './findings'
import { registerCompactionStore } from './compact'
import type { HistoryReader } from './mcp/tool'

export type LogKind = 'finding' | 'tool_call' | 'approval'

export interface LogFilter {
  /** Restrict to one row kind; omit for all three. */
  kind?: LogKind
  /** Only tool calls for this tool name. */
  tool?: string
  /** Only rows at/after this epoch-ms timestamp. */
  since?: number
  /** Max rows returned (default 100, capped at 500). */
  limit?: number
}

export type LogRow =
  | { type: 'finding'; id: string; title: string; severity: FindingSeverity; ts: number }
  | {
      type: 'tool_call'
      id: string
      tool: string
      target?: string
      riskTier: string
      ok: boolean
      error?: string
      startedAt: number
      finishedAt?: number
      /** Present when the row was compacted: the stored one-line summary, so a
       *  reader doesn't have to reconstruct it (params may have been trimmed). */
      summary?: string
    }
  | { type: 'approval'; id: string; decision: string; actor?: string; ts: number }

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)))
}

const tsOf = (row: LogRow): number => (row.type === 'tool_call' ? row.startedAt : row.ts)

export function createHistoryReader(db: Database, findings: FindingsStore): HistoryReader {
  // Register the shared SQLite handle + findings store for conversation
  // compaction: the tool context is reader-only, and this factory already owns
  // both, so `compact_conversation` gets them here instead of a second wiring
  // path (see compact.ts). Registering is a no-op side effect for query_log.
  registerCompactionStore({ db, findings })

  const toolCallRows = (since: number, tool: string | undefined): LogRow[] => {
    const raw = db.all(
      'SELECT id, tool, target, risk_tier, ok, error, started_ts, finished_ts, summary_json, compacted FROM tool_calls WHERE started_ts >= ? AND (? IS NULL OR tool = ?) ORDER BY started_ts DESC',
      [since, tool ?? null, tool ?? null]
    )
    return raw.map((row) => {
      const r = row as Record<string, unknown>
      return {
        type: 'tool_call' as const,
        id: String(r.id),
        tool: String(r.tool),
        ...(typeof r.target === 'string' ? { target: r.target } : {}),
        riskTier: String(r.risk_tier),
        ok: r.ok === 1,
        ...(typeof r.error === 'string' ? { error: r.error } : {}),
        startedAt: Number(r.started_ts) || 0,
        ...(r.finished_ts == null ? {} : { finishedAt: Number(r.finished_ts) }),
        // Compacted rows carry their stored one-line summary; the rest of the
        // fields stay intact so existing consumers keep working.
        ...(r.compacted === 1 && typeof r.summary_json === 'string'
          ? { summary: r.summary_json }
          : {})
      }
    })
  }

  const findingRows = (since: number): LogRow[] =>
    findings
      .list()
      .filter((r) => r.ts >= since)
      .map((r) => {
        const s = findingSummary(r)
        return { type: 'finding' as const, id: s.id, title: s.title, severity: s.severity, ts: r.ts }
      })

  const approvalRows = (since: number): LogRow[] =>
    db
      .all('SELECT id, decision, actor, ts FROM approvals WHERE ts >= ? ORDER BY ts DESC', [since])
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          type: 'approval' as const,
          id: String(r.id),
          decision: String(r.decision),
          ...(typeof r.actor === 'string' ? { actor: r.actor } : {}),
          ts: Number(r.ts) || 0
        }
      })

  return {
    query: async (filter) => {
      const f = (filter ?? {}) as LogFilter
      const limit = clampLimit(f.limit)
      const since = typeof f.since === 'number' ? f.since : 0
      const tool = typeof f.tool === 'string' && f.tool ? f.tool : undefined
      const kinds: LogKind[] = f.kind ? [f.kind] : ['finding', 'tool_call', 'approval']

      const rows: LogRow[] = []
      if (kinds.includes('finding')) rows.push(...findingRows(since))
      if (kinds.includes('tool_call')) rows.push(...toolCallRows(since, tool))
      if (kinds.includes('approval')) rows.push(...approvalRows(since))

      return rows.sort((a, b) => tsOf(b) - tsOf(a)).slice(0, limit)
    }
  }
}
