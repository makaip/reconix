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
