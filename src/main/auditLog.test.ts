import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLogger } from './auditLog'
import { openDatabase } from './db'

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'reconix-audit-')), 'reconix.db')

describe('createAuditLogger', () => {
  it('records an intent row and fills the outcome into the same row', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    const id = await audit.recordIntent({
      engagementId: 'eng',
      tool: 'navigate',
      params: { url: 'http://x/' },
      target: 'http://x/',
      riskTier: 'R'
    })

    expect(id).toBe('tc_1')
    const intent = db.get('SELECT * FROM tool_calls WHERE id = ?', [id]) as Record<string, unknown>
    expect(intent.tool).toBe('navigate')
    expect(intent.ok).toBeNull() // no outcome yet
    expect(intent.finished_ts).toBeNull()

    await audit.recordOutcome(id, { ok: true })
    const done = db.get('SELECT ok, finished_ts FROM tool_calls WHERE id = ?', [id]) as Record<
      string,
      unknown
    >
    expect(done.ok).toBe(1)
    expect(done.finished_ts).not.toBeNull()
    // one row per call, updated in place — never a second row
    expect(db.all('SELECT id FROM tool_calls')).toHaveLength(1)
  })

  it('records a failed outcome with its error', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    const id = await audit.recordIntent({ engagementId: 'eng', tool: 'fill', params: {}, riskTier: 'P' })
    await audit.recordOutcome(id, { ok: false, error: 'boom' })

    const row = db.get('SELECT ok, error FROM tool_calls WHERE id = ?', [id]) as Record<string, unknown>
    expect(row.ok).toBe(0)
    expect(row.error).toBe('boom')
  })

  it('stores a null engagement id when no scope is loaded', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    await audit.recordIntent({ engagementId: null, tool: 'navigate', params: {}, riskTier: 'R' })

    const row = db.get('SELECT engagement_id FROM tool_calls') as Record<string, unknown>
    expect(row.engagement_id).toBeNull()
  })

  it('appends approval decisions to the approvals table', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    const id = await audit.recordApproval({
      approvalId: 'perm_1',
      decision: 'approve',
      actor: 'operator'
    })

    expect(id).toBe('perm_1')
    const row = db.get('SELECT * FROM approvals WHERE id = ?', [id]) as Record<string, unknown>
    expect(row).toMatchObject({
      tool_call_id: null,
      decision: 'approve',
      edited_params_json: null,
      actor: 'operator'
    })
    expect(row.ts).not.toBeNull()
  })

  it('records an edit decision with its params', async () => {
    const db = openDatabase()
    const audit = createAuditLogger(db)
    await audit.recordApproval({
      approvalId: 'perm_2',
      toolCallId: 'tc_9',
      decision: 'edit',
      editedParams: { url: 'http://x/' }
    })

    const row = db.get('SELECT tool_call_id, edited_params_json FROM approvals') as Record<
      string,
      unknown
    >
    expect(row.tool_call_id).toBe('tc_9')
    expect(JSON.parse(String(row.edited_params_json))).toEqual({ url: 'http://x/' })
  })

  it('continues the id sequence across restarts', async () => {
    const file = tempFile()
    const firstDb = openDatabase(file)
    await createAuditLogger(firstDb).recordIntent({
      engagementId: 'e',
      tool: 'a',
      params: {},
      riskTier: 'R'
    })
    firstDb.close()

    const secondDb = openDatabase(file)
    const id = await createAuditLogger(secondDb).recordIntent({
      engagementId: 'e',
      tool: 'b',
      params: {},
      riskTier: 'R'
    })
    expect(id).toBe('tc_2')
    secondDb.close()
  })
})
