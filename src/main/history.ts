// History reader (ARCHITECTURE §6.4) — backs query_log, the agent's only history
// access. Reads the persisted engagement log: tool calls from `tool_calls` plus
// recorded findings, merged newest-first. Structured and narrow — never a DB
// handle. Filter keys are read defensively; anything unrecognized is ignored.
import type { Database } from 'node-sqlite3-wasm'
import type { FindingSeverity } from '../shared/findings'
import { findingSummary, type FindingsStore } from './findings'
import type { HistoryReader } from './mcp/tool'

export interface LogFilter {
  /** Restrict to one row kind; omit for both. */
  kind?: 'tool_call' | 'finding'
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
    }

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)))
}

const tsOf = (row: LogRow): number => (row.type === 'finding' ? row.ts : row.startedAt)

export function createHistoryReader(db: Database, findings: FindingsStore): HistoryReader {
  const toolCallRows = (since: number, tool: string | undefined): LogRow[] => {
    const raw = db.all(
      'SELECT id, tool, target, risk_tier, ok, error, started_ts, finished_ts FROM tool_calls WHERE started_ts >= ? AND (? IS NULL OR tool = ?) ORDER BY started_ts DESC',
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
        ...(r.finished_ts == null ? {} : { finishedAt: Number(r.finished_ts) })
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

  return {
    query: async (filter) => {
      const f = (filter ?? {}) as LogFilter
      const limit = clampLimit(f.limit)
      const since = typeof f.since === 'number' ? f.since : 0
      const tool = typeof f.tool === 'string' && f.tool ? f.tool : undefined

      const rows: LogRow[] = []
      if (f.kind !== 'tool_call') rows.push(...findingRows(since))
      if (f.kind !== 'finding') rows.push(...toolCallRows(since, tool))

      return rows.sort((a, b) => tsOf(b) - tsOf(a)).slice(0, limit)
    }
  }
}
