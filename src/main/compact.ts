// Conversation compaction (engagement-history checkpoints).
//
// Boundary note: Reconix does NOT own the LLM's conversation window — OpenCode
// does. What this module compacts is Reconix's OWN persisted engagement history:
// `tool_calls`, findings and approvals. The point is that an orchestrator can
// read one checkpoint narrative instead of paging through dozens of `query_log`
// rows, and the DB can drop the bulky `params_json` of calls old enough that
// nobody will re-run them from history.
//
// Deliberately dependency-light: `db` is always passed in, there are no
// electron/trace imports, and timestamps come from `Date.now()` at call time, so
// the whole module is unit-testable against an in-memory database.
import type { Database } from 'node-sqlite3-wasm'
import type { FindingSeverity } from '../shared/findings'
import { findingSummary, type FindingsStore, type StoredFinding } from './findings'

/** Default "old enough to compact" window: rows older than a day. */
export const DEFAULT_OLDER_THAN_MS = 24 * 60 * 60 * 1000
/** Default cap per pass, so one call can't rewrite the whole log. */
export const DEFAULT_MAX_ROWS = 200

/** Targets longer than this are truncated in a one-line summary. */
const MAX_TARGET_CHARS = 80
/** Error text is collapsed to one line and capped at this length. */
const MAX_ERROR_CHARS = 120
/** How many one-line summaries the narrative's `Recent:` line shows. */
const RECENT_LIMIT = 5

const SEVERITY_ORDER: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info']

export interface CompactOptions {
  /** Restrict the narrative to a slice of history (same shape as query_log). */
  filter?: { since?: number; tool?: string; kind?: string; limit?: number }
  /** Age window for rows to compact; defaults to 24h. */
  compactOlderThanMs?: number
  /** Cap on rows compacted in this pass; defaults to 200. */
  maxRowsToCompact?: number
  /** 'trace' asks the MCP tool layer to persist the narrative as a trace. */
  storeAs?: 'trace' | 'none'
}

export interface CompactResult {
  summary: string
  rowsCompacted: number
  /** Set by the MCP tool layer when `storeAs === 'trace'`. */
  ref?: string
  storedAt: number
}

/** A tool_calls row as read for summarization. Only the display columns. */
export interface ToolCallSummaryInput {
  id?: unknown
  tool?: unknown
  target?: unknown
  ok?: unknown
  error?: unknown
  started_ts?: unknown
  finished_ts?: unknown
  summary_json?: unknown
  compacted?: unknown
}

// ── formatting helpers ───────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM` in local time — compact enough for a one-line call summary. */
function clock(ts: unknown): string | undefined {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `YYYY-MM-DD HH:MM` for the narrative's range line (date changes matter there). */
function stamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Targets are agent-supplied and can be long URLs; cap them at 80 chars. */
function shortTarget(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined
  const t = target.trim()
  if (!t) return undefined
  return t.length > MAX_TARGET_CHARS ? `${t.slice(0, MAX_TARGET_CHARS - 1)}…` : t
}

/** Errors may be multi-line stack text; a summary line stays on one line. */
function shortError(error: unknown, ok: unknown): string {
  const fallback = ok === undefined || ok === null ? 'pending' : 'failed'
  if (typeof error !== 'string') return fallback
  const oneLine = error.replace(/\s+/g, ' ').trim()
  if (!oneLine) return fallback
  return oneLine.length > MAX_ERROR_CHARS ? `${oneLine.slice(0, MAX_ERROR_CHARS - 1)}…` : oneLine
}

/** ok is stored as 0/1 but read defensively (null = never settled). */
function outcomeOf(row: ToolCallSummaryInput): string {
  if (row.ok === 1 || row.ok === true) return 'ok'
  if (row.ok === 0 || row.ok === false) return `error: ${shortError(row.error, row.ok)}`
  return 'pending'
}

/**
 * One-line summary of a tool_calls row:
 *   `nuclei_scan(http://target/login) → ok [13:00→13:02]`
 *   `ffuf_fuzz → error: wordlist missing`
 * Target, outcome and the start→finish clock are each optional, so a partial
 * (still-running or target-less) row still renders one honest line.
 */
export function summarizeToolCall(row: Record<string, unknown>): string {
  const r = row as ToolCallSummaryInput
  const tool = typeof r.tool === 'string' && r.tool ? r.tool : 'unknown_tool'
  const target = shortTarget(r.target)
  const head = target ? `${tool}(${target})` : tool

  const started = clock(r.started_ts)
  const finished = clock(r.finished_ts ?? undefined)
  const span = started && finished ? ` [${started}→${finished}]` : started ? ` [${started}]` : ''

  return `${head} → ${outcomeOf(r)}${span}`
}

// ── compaction ───────────────────────────────────────────────────────────────

/** `params_json` is declared NOT NULL by the shipped schema, so "drop the
 *  params" stores the JSON null literal there and falls back to SQL NULL only on
 *  a database where the column was rebuilt as nullable. */
function trimParamsJson(db: Database, id: string): void {
  try {
    db.run('UPDATE tool_calls SET params_json = NULL WHERE id = ?', [id])
  } catch {
    db.run("UPDATE tool_calls SET params_json = 'null' WHERE id = ?", [id])
  }
}

/**
 * Summarize and trim old, not-yet-compacted tool_calls rows. Oldest first, so a
 * cap leaves the most recent calls untouched (the ones an agent is most likely
 * to still need in full). Returns how many rows were compacted.
 */
export function compactToolCalls(
  db: Database,
  opts: { olderThanMs?: number; maxRows?: number } = {}
): number {
  const olderThanMs =
    typeof opts.olderThanMs === 'number' && Number.isFinite(opts.olderThanMs) && opts.olderThanMs >= 0
      ? opts.olderThanMs
      : DEFAULT_OLDER_THAN_MS
  const maxRows =
    typeof opts.maxRows === 'number' && Number.isFinite(opts.maxRows) && opts.maxRows > 0
      ? Math.floor(opts.maxRows)
      : DEFAULT_MAX_ROWS

  const cutoff = Date.now() - olderThanMs
  const rows = db.all(
    `SELECT id, tool, target, ok, error, started_ts, finished_ts
       FROM tool_calls
      WHERE compacted = 0 AND started_ts < ?
      ORDER BY started_ts ASC
      LIMIT ?`,
    [cutoff, maxRows]
  )

  let compacted = 0
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const id = String(r.id)
    db.run('UPDATE tool_calls SET summary_json = ?, compacted = 1 WHERE id = ?', [
      summarizeToolCall(r),
      id
    ])
    trimParamsJson(db, id)
    compacted += 1
  }
  return compacted
}

// ── narrative ────────────────────────────────────────────────────────────────

interface NarrativeRow {
  tool: string
  summary: string
  startedAt: number
  ok: boolean | null
}

/** Newest-first one-line summaries, preferring a stored compacted summary. */
function recentLines(rows: NarrativeRow[]): string {
  if (rows.length === 0) return 'Recent: none'
  const recent = [...rows]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, RECENT_LIMIT)
    .map((r) => r.summary)
  return `Recent: ${recent.join('; ')}`
}

function severityCounts(rows: StoredFinding[], since: number): Map<FindingSeverity, number> {
  const counts = new Map<FindingSeverity, number>()
  for (const row of rows) {
    if (row.ts < since) continue
    const { severity } = findingSummary(row)
    counts.set(severity, (counts.get(severity) ?? 0) + 1)
  }
  return counts
}

/**
 * Compact narrative checkpoint of the engagement's recorded history:
 *
 *   Engagement compact (checkpoint) — <range or "no calls yet">
 *   Tool calls: N total — name(count, ok), name(count, err), …
 *   Findings: M — critical(x), high(x), …
 *   Approvals: A — allow(x), reject(x), …
 *   Recent: <last 5 one-line summaries>
 *
 * Counts cover ALL tool_calls (compacted or not) — the summary is the durable
 * record, so compacting a row must not change the totals.
 */
export function buildEngagementSummary(
  db: Database,
  findingsStore: FindingsStore,
  engagementId: string | null,
  filter?: CompactOptions['filter']
): string {
  const since = typeof filter?.since === 'number' && Number.isFinite(filter.since) ? filter.since : 0
  const toolFilter = typeof filter?.tool === 'string' && filter.tool ? filter.tool : undefined
  const limit =
    typeof filter?.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
      ? Math.floor(filter.limit)
      : undefined

  // ── tool calls ──
  const rawCalls = db.all(
    `SELECT id, tool, target, ok, error, started_ts, finished_ts, summary_json, compacted
       FROM tool_calls
      WHERE started_ts >= ?
        AND (? IS NULL OR engagement_id = ?)
        AND (? IS NULL OR tool = ?)
      ORDER BY started_ts ASC`,
    [since, engagementId, engagementId, toolFilter ?? null, toolFilter ?? null]
  )

  const calls: NarrativeRow[] = rawCalls.map((row) => {
    const r = row as Record<string, unknown>
    const stored = r.compacted === 1 && typeof r.summary_json === 'string' ? r.summary_json : undefined
    return {
      tool: typeof r.tool === 'string' ? r.tool : 'unknown_tool',
      summary: stored ?? summarizeToolCall(r),
      startedAt: typeof r.started_ts === 'number' ? r.started_ts : 0,
      ok: r.ok === 1 ? true : r.ok === 0 ? false : null
    }
  })

  // `filter.limit` caps the newest rows the counts describe — an explicit agent
  // request, so it narrows the slice instead of silently meaning something else.
  const considered = limit !== undefined && calls.length > limit ? calls.slice(-limit) : calls

  const byTool = new Map<string, { ok: number; err: number }>()
  for (const call of considered) {
    const counts = byTool.get(call.tool) ?? { ok: 0, err: 0 }
    if (call.ok === true) counts.ok += 1
    else if (call.ok === false) counts.err += 1
    byTool.set(call.tool, counts)
  }
  const toolParts = [...byTool.entries()]
    .sort((a, b) => b[1].ok + b[1].err - (a[1].ok + a[1].err))
    .flatMap(([tool, counts]) => {
      const parts: string[] = []
      if (counts.ok > 0) parts.push(`${tool}(${counts.ok}, ok)`)
      if (counts.err > 0) parts.push(`${tool}(${counts.err}, err)`)
      return parts
    })

  // ── findings ──
  const counts = severityCounts(findingsStore.list(), since)
  const findingTotal = [...counts.values()].reduce((a, b) => a + b, 0)
  const severityParts = SEVERITY_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map(
    (s) => `${s}(${counts.get(s)})`
  )

  // ── approvals (scoped through the tool_call they belong to) ──
  const approvalRows = db.all(
    `SELECT a.decision AS decision
       FROM approvals a
       LEFT JOIN tool_calls t ON t.id = a.tool_call_id
      WHERE a.ts >= ?
        AND (? IS NULL OR a.tool_call_id IS NULL OR t.engagement_id = ?)`,
    [since, engagementId, engagementId]
  )
  const byDecision = new Map<string, number>()
  for (const row of approvalRows) {
    const decision = String((row as Record<string, unknown>).decision)
    byDecision.set(decision, (byDecision.get(decision) ?? 0) + 1)
  }
  const approvalTotal = approvalRows.length
  const decisionParts = [...byDecision.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([decision, n]) => `${decision}(${n})`)

  // ── assemble ──
  const empty = considered.length === 0 && findingTotal === 0 && approvalTotal === 0
  if (empty) return 'Engagement compact (checkpoint) — no recorded activity yet'

  const range =
    considered.length > 0
      ? `${stamp(considered[0].startedAt)} → ${stamp(considered[considered.length - 1].startedAt)}`
      : 'no calls yet'

  return [
    `Engagement compact (checkpoint) — ${range}`,
    `Tool calls: ${considered.length} total${toolParts.length ? ` — ${toolParts.join(', ')}` : ''}`,
    `Findings: ${findingTotal}${severityParts.length ? ` — ${severityParts.join(', ')}` : ''}`,
    `Approvals: ${approvalTotal}${decisionParts.length ? ` — ${decisionParts.join(', ')}` : ''}`,
    recentLines(considered)
  ].join('\n')
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Compact old rows, then build the checkpoint narrative. Storing the narrative
 * as a trace is deliberately NOT done here (that needs the electron-side trace
 * store); the `compact_conversation` MCP tool owns that when asked.
 */
export async function compactEngagement(
  db: Database,
  findingsStore: FindingsStore,
  engagementId: string | null,
  opts: CompactOptions = {}
): Promise<CompactResult> {
  const rowsCompacted = compactToolCalls(db, {
    olderThanMs: opts.compactOlderThanMs,
    maxRows: opts.maxRowsToCompact
  })
  const summary = buildEngagementSummary(db, findingsStore, engagementId, opts.filter)
  return { summary, rowsCompacted, storedAt: Date.now() }
}

// ── store wiring ─────────────────────────────────────────────────────────────

/** What the MCP tool layer needs to run a compaction pass. */
export interface CompactionStore {
  db: Database
  findings: FindingsStore
}

// The tool context (mcp/tool.ts) exposes readers, not a DB handle, and the tool
// layer is created before the bridge's stores. Rather than handing raw SQL to
// every tool, the one place that already owns both — createHistoryReader — calls
// registerCompactionStore once, so compact_conversation reads the same shared
// SQLite database as everything else.
let activeStore: CompactionStore | null = null

export function registerCompactionStore(store: CompactionStore): void {
  activeStore = store
}

export function getCompactionStore(): CompactionStore | null {
  return activeStore
}

/** Test seam: detach the registered store. */
export function resetCompactionStore(): void {
  activeStore = null
}
