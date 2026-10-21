import { describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import type { FindingsStore, StoredFinding } from './findings'
import { createHistoryReader } from './history'
import {
  buildEngagementSummary,
  compactEngagement,
  compactToolCalls,
  summarizeToolCall
} from './compact'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

type Db = ReturnType<typeof openDatabase>

interface CallRow {
  id: string
  tool: string
  target?: string | null
  ok?: number | null
  error?: string | null
  started: number
  finished?: number | null
  params?: unknown
  engagement?: string | null
}

/** Insert a tool_calls row the way auditLog.ts does (same column set). */
function insertCall(db: Db, row: CallRow): void {
  db.run(
    'INSERT INTO tool_calls (id, engagement_id, tool, params_json, target, risk_tier, ok, error, started_ts, finished_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      row.id,
      row.engagement === undefined ? 'e1' : row.engagement,
      row.tool,
      JSON.stringify(row.params ?? { url: 'http://target/login', body: 'x'.repeat(200) }),
      row.target === undefined ? null : row.target,
      'R',
      row.ok === undefined ? 1 : row.ok,
      row.error === undefined ? null : row.error,
      row.started,
      row.finished === undefined ? row.started + 60_000 : row.finished
    ]
  )
}

const readRow = (db: Db, id: string): Record<string, unknown> =>
  db.get('SELECT * FROM tool_calls WHERE id = ?', [id]) as Record<string, unknown>

const fakeFindings = (rows: StoredFinding[]): FindingsStore => ({
  sink: { record: async () => 'finding_x' },
  list: () => rows,
  summary: () => [],
  update: () => false,
  clear: () => undefined,
  close: () => undefined
})

const finding = (id: string, ts: number, severity = 'high'): StoredFinding => ({
  id,
  schema: { title: `Finding ${id}`, severity },
  evidenceRef: `trace_${id}`,
  ts,
  status: 'open'
})

describe('compactToolCalls', () => {
  it('summarizes and trims old rows, leaving recent ones untouched', () => {
    const db = openDatabase()
    const now = Date.now()
    insertCall(db, { id: 'tc_1', tool: 'nuclei_scan', target: 'http://target/login', started: now - 3 * DAY })
    insertCall(db, { id: 'tc_2', tool: 'ffuf_fuzz', started: now - 2 * DAY, ok: 0, error: 'wordlist missing' })
    insertCall(db, { id: 'tc_3', tool: 'navigate', target: 'http://target/', started: now - HOUR })

    expect(compactToolCalls(db)).toBe(2)

    const first = readRow(db, 'tc_1')
    expect(first.compacted).toBe(1)
    expect(typeof first.summary_json).toBe('string')
    expect(String(first.summary_json)).toContain('nuclei_scan(http://target/login)')
    expect(String(first.summary_json)).toContain('→ ok')
    // params are dropped. The shipped schema declares params_json NOT NULL, so
    // the trim stores SQLite's JSON-null literal (`null`) rather than violating
    // the constraint; the bulky body/url are gone either way.
    expect(first.params_json).toBe('null')

    // untouched: still full detail, not compacted
    const recent = readRow(db, 'tc_3')
    expect(recent.compacted).toBe(0)
    expect(recent.summary_json).toBeNull()
    expect(String(recent.params_json)).toContain('http://target/login')

    db.close()
  })

  it('leaves rows inside the age window alone', () => {
    const db = openDatabase()
    const now = Date.now()
    insertCall(db, { id: 'tc_1', tool: 'navigate', started: now - 30 * 60 * 1000 })

    expect(compactToolCalls(db)).toBe(0)
    expect(readRow(db, 'tc_1').compacted).toBe(0)
    db.close()
  })

  it('honors olderThanMs and maxRows, oldest first', () => {
    const db = openDatabase()
    const now = Date.now()
    insertCall(db, { id: 'tc_1', tool: 'a', started: now - 4 * DAY })
    insertCall(db, { id: 'tc_2', tool: 'b', started: now - 3 * DAY })
    insertCall(db, { id: 'tc_3', tool: 'c', started: now - 2 * DAY })

    // Only tc_1 is older than 3 days.
    expect(compactToolCalls(db, { olderThanMs: 3 * DAY })).toBe(1)
    expect(readRow(db, 'tc_1').compacted).toBe(1)
    expect(readRow(db, 'tc_2').compacted).toBe(0)

    // Cap at one row, oldest first: tc_2 before tc_3.
    expect(compactToolCalls(db, { maxRows: 1 })).toBe(1)
    expect(readRow(db, 'tc_2').compacted).toBe(1)
    expect(readRow(db, 'tc_3').compacted).toBe(0)

    // Already-compacted rows are skipped on a second pass.
    expect(compactToolCalls(db, { maxRows: 5 })).toBe(1) // only tc_3 left
    expect(compactToolCalls(db)).toBe(0)
    db.close()
  })
})

describe('summarizeToolCall', () => {
  it('renders target, outcome and the start→finish clock', () => {
    const started = new Date(2026, 9, 21, 13, 0).getTime()
    const finished = new Date(2026, 9, 21, 13, 2).getTime()
    expect(
      summarizeToolCall({ tool: 'nuclei_scan', target: 'http://target/login', ok: 1, started_ts: started, finished_ts: finished })
    ).toBe('nuclei_scan(http://target/login) → ok [13:00→13:02]')
  })

  it('renders an error without a target', () => {
    expect(summarizeToolCall({ tool: 'ffuf_fuzz', ok: 0, error: 'wordlist missing' })).toBe(
      'ffuf_fuzz → error: wordlist missing'
    )
  })

  it('truncates a long target to 80 chars', () => {
    const target = `http://target/${'a'.repeat(200)}`
    const summary = summarizeToolCall({ tool: 'navigate', target, ok: 1 })
    const inParens = summary.slice('navigate('.length, summary.indexOf(')'))
    expect(inParens).toHaveLength(80)
    expect(inParens.endsWith('…')).toBe(true)
  })

  it('handles a still-running call (no finished_ts, ok null)', () => {
    expect(
      summarizeToolCall({ tool: 'nmap_scan', ok: null, started_ts: new Date(2026, 9, 21, 9, 5).getTime() })
    ).toBe('nmap_scan → pending [09:05]')
  })
})

describe('buildEngagementSummary', () => {
  it('groups tool calls, findings and approvals into a checkpoint', () => {
    const db = openDatabase()
    const now = new Date(2026, 9, 21, 13, 0).getTime()
    insertCall(db, { id: 'tc_1', tool: 'nuclei_scan', target: 'http://t/a', started: now, finished: now + 60_000 })
    insertCall(db, { id: 'tc_2', tool: 'nuclei_scan', target: 'http://t/b', started: now + 60_000 })
    insertCall(db, { id: 'tc_3', tool: 'ffuf_fuzz', started: now + 120_000, ok: 0, error: 'wordlist missing' })

    db.run("INSERT INTO approvals (id, tool_call_id, decision, ts) VALUES ('perm_1', 'tc_3', 'allow', ?)", [now + 120_000])
    db.run("INSERT INTO approvals (id, tool_call_id, decision, ts) VALUES ('perm_2', 'tc_3', 'reject', ?)", [now + 121_000])

    const findings = fakeFindings([
      finding('finding_1', now, 'critical'),
      finding('finding_2', now, 'high'),
      finding('finding_3', now, 'info')
    ])

    const summary = buildEngagementSummary(db, findings, 'e1')
    const lines = summary.split('\n')

    expect(lines[0]).toMatch(/^Engagement compact \(checkpoint\) — 2026-10-21 13:00 → /)
    expect(summary).toContain('Tool calls: 3 total')
    expect(summary).toContain('nuclei_scan(2, ok)')
    expect(summary).toContain('ffuf_fuzz(1, err)')
    expect(summary).toContain('Findings: 3')
    expect(summary).toContain('critical(1)')
    expect(summary).toContain('high(1)')
    expect(summary).toContain('info(1)')
    expect(summary).toContain('Approvals: 2')
    expect(summary).toContain('allow(1)')
    expect(summary).toContain('reject(1)')
    expect(summary).toContain('Recent: ')
    expect(summary).toContain('nuclei_scan(http://t/b)')
    // never more than five recent lines
    expect(summary.split('; ').length).toBeLessThanOrEqual(5)
    db.close()
  })

  it('uses the stored summary for compacted rows', () => {
    const db = openDatabase()
    const now = Date.now()
    insertCall(db, { id: 'tc_1', tool: 'navigate', target: 'http://t/', started: now - 2 * DAY })
    compactToolCalls(db)

    const summary = buildEngagementSummary(db, fakeFindings([]), 'e1')
    expect(summary).toContain('navigate(http://t/)')
    expect(summary).toContain('Tool calls: 1 total')
    db.close()
  })

  it('reports an empty engagement plainly', () => {
    const db = openDatabase()
    expect(buildEngagementSummary(db, fakeFindings([]), 'e1')).toBe(
      'Engagement compact (checkpoint) — no recorded activity yet'
    )
    db.close()
  })

  it('scopes to the engagement and honors filter.since', () => {
    const db = openDatabase()
    const now = Date.now()
    insertCall(db, { id: 'tc_1', tool: 'mine', started: now, engagement: 'e1' })
    insertCall(db, { id: 'tc_2', tool: 'other', started: now, engagement: 'e2' })
    insertCall(db, { id: 'tc_3', tool: 'old', started: now - 10 * DAY, engagement: 'e1' })

    const summary = buildEngagementSummary(db, fakeFindings([]), 'e1', { since: now - DAY })
    expect(summary).toContain('Tool calls: 1 total')
    expect(summary).toContain('mine(1, ok)')
    expect(summary).not.toContain('other')
    expect(summary).not.toContain('old')
    db.close()
  })
})

describe('compactEngagement', () => {
  it('returns the narrative plus how many rows were compacted', async () => {
    const db = openDatabase()
    const now = Date.now()
    insertCall(db, { id: 'tc_1', tool: 'nuclei_scan', target: 'http://t/a', started: now - 3 * DAY })
    insertCall(db, { id: 'tc_2', tool: 'navigate', target: 'http://t/', started: now - HOUR })

    const result = await compactEngagement(db, fakeFindings([finding('finding_1', now, 'high')]), 'e1', {
      compactOlderThanMs: DAY,
      maxRowsToCompact: 10
    })

    expect(result.rowsCompacted).toBe(1)
    expect(result.summary).toContain('Tool calls: 2 total')
    expect(result.summary).toContain('Findings: 1')
    expect(result.storedAt).toBeGreaterThan(0)
    expect(readRow(db, 'tc_1').compacted).toBe(1)
    expect(readRow(db, 'tc_2').compacted).toBe(0)
    db.close()
  })
})

describe('history reader + compacted rows', () => {
  it('exposes summary on the tool_call LogRow', async () => {
    const db = openDatabase()
    const now = Date.now()
    insertCall(db, { id: 'tc_1', tool: 'nuclei_scan', target: 'http://t/a', started: now - 2 * DAY })
    compactToolCalls(db)

    const rows = (await createHistoryReader(db, fakeFindings([])).query({ kind: 'tool_call' })) as Array<
      Record<string, unknown>
    >
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'tool_call',
      id: 'tc_1',
      tool: 'nuclei_scan',
      target: 'http://t/a',
      riskTier: 'R',
      ok: true
    })
    expect(typeof rows[0].summary).toBe('string')
    expect(String(rows[0].summary)).toContain('nuclei_scan(http://t/a)')
    db.close()
  })

  it('omits summary for rows that were never compacted', async () => {
    const db = openDatabase()
    insertCall(db, { id: 'tc_1', tool: 'navigate', started: Date.now() })
    const rows = (await createHistoryReader(db, fakeFindings([])).query({ kind: 'tool_call' })) as Array<
      Record<string, unknown>
    >
    expect(rows[0]).not.toHaveProperty('summary')
    db.close()
  })
})
