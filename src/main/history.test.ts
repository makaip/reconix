import { describe, expect, it } from 'vitest'
import { createAuditLogger } from './auditLog'
import { openDatabase } from './db'
import type { FindingsStore, StoredFinding } from './findings'
import { createHistoryReader } from './history'

const fakeFindings = (rows: StoredFinding[]): FindingsStore => ({
  sink: { record: async () => 'finding_x' },
  list: () => rows,
  summary: () => [],
  close: () => undefined
})

const finding = (id: string, ts: number, severity = 'high'): StoredFinding => ({
  id,
  schema: { title: `Finding ${id}`, severity },
  evidenceRef: `trace_${id}`,
  ts
})

describe('createHistoryReader', () => {
  it('merges findings and tool calls, newest first', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    const id = await audit.recordIntent({
      engagementId: 'e',
      tool: 'navigate',
      params: {},
      target: 'http://x/',
      riskTier: 'R'
    })
    await audit.recordOutcome(id, { ok: true })

    const history = createHistoryReader(db, fakeFindings([finding('finding_1', 1)]))
    const rows = (await history.query({})) as Array<{ type: string }>

    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['finding', 'tool_call']))
    // newest (the tool call) sorts ahead of the ts=1 finding
    expect(rows[0].type).toBe('tool_call')
  })

  it('exposes the tool-call outcome', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    const id = await audit.recordIntent({
      engagementId: 'e',
      tool: 'navigate',
      params: {},
      target: 'http://x/',
      riskTier: 'R'
    })
    await audit.recordOutcome(id, { ok: false, error: 'out of scope' })

    const history = createHistoryReader(db, fakeFindings([]))
    const [row] = (await history.query({ kind: 'tool_call' })) as Array<Record<string, unknown>>
    expect(row).toMatchObject({ type: 'tool_call', tool: 'navigate', ok: false, error: 'out of scope' })
  })

  it('filters by kind', async () => {
    const db = openDatabase()
    const history = createHistoryReader(db, fakeFindings([finding('finding_1', 1)]))
    const rows = (await history.query({ kind: 'finding' })) as Array<{ type: string }>
    expect(rows.map((r) => r.type)).toEqual(['finding'])
  })

  it('filters tool calls by tool name', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    for (const tool of ['navigate', 'click']) {
      await audit.recordIntent({ engagementId: 'e', tool, params: {}, riskTier: 'R' })
    }
    const history = createHistoryReader(db, fakeFindings([]))
    const rows = (await history.query({ tool: 'click' })) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect((rows[0] as { tool: string }).tool).toBe('click')
  })

  it('honors the limit', async () => {
    const db = openDatabase()
    const history = createHistoryReader(
      db,
      fakeFindings([finding('a', 1), finding('b', 2), finding('c', 3)])
    )
    expect(await history.query({ limit: 2 })).toHaveLength(2)
  })
})
