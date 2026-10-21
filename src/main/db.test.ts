import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'node-sqlite3-wasm'
import { openDatabase } from './db'

const columns = (db: ReturnType<typeof openDatabase>, table: string): string[] =>
  (db.all(`SELECT name FROM pragma_table_info('${table}')`) as Array<{ name: string }>).map(
    (c) => c.name
  )

describe('openDatabase', () => {
  it('creates the §6.4 tables on a fresh database', () => {
    const db = openDatabase()
    expect(columns(db, 'findings')).toEqual([
      'id',
      'engagement_id',
      'schema_json',
      'evidence_ref',
      'status',
      'notes',
      'cvss',
      'ts'
    ])
    expect(columns(db, 'engagements')).toEqual(['id', 'goal', 'scope_json', 'policy_json', 'started_at', 'stopped_at', 'status'])
    expect(columns(db, 'traces')).toEqual(['id', 'engagement_id', 'kind', 'path', 'ts'])
    expect(columns(db, 'tool_calls')).toContain('risk_tier')
    expect(columns(db, 'approvals')).toEqual([
      'id',
      'tool_call_id',
      'decision',
      'edited_params_json',
      'actor',
      'ts'
    ])
    db.close()
  })

  it('adds the triage columns to a pre-existing findings table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconix-db-'))
    const file = join(dir, 'reconix.db')

    // Simulate the shipped §6.4 shape (status, but no notes/cvss) with a row.
    const old = new Database(file)
    old.exec(
      `CREATE TABLE findings (
         id TEXT PRIMARY KEY,
         engagement_id TEXT,
         schema_json TEXT NOT NULL,
         evidence_ref TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'open',
         ts INTEGER NOT NULL
       )`
    )
    old.run(
      "INSERT INTO findings (id, schema_json, evidence_ref, ts) VALUES ('finding_1', '{}', 'trace_1', 1)"
    )
    old.close()

    const db = openDatabase(file)
    expect(columns(db, 'findings')).toEqual(
      expect.arrayContaining(['status', 'notes', 'cvss'])
    )
    // The pre-existing row survives and picks up the defaults.
    const row = db.get('SELECT status, notes, cvss FROM findings') as {
      status: string
      notes: string | null
      cvss: number | null
    }
    expect(row.status).toBe('open')
    expect(row.notes).toBeNull()
    expect(row.cvss).toBeNull()

    // Reopening must be a no-op, not a duplicate-column error.
    db.close()
    const again = openDatabase(file)
    expect(columns(again, 'findings')).toEqual(expect.arrayContaining(['status', 'notes', 'cvss']))
    again.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rebuilds a pre-release traces table that stored bytes inline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconix-db-'))
    const file = join(dir, 'reconix.db')

    // Simulate the old shape (a `data` BLOB instead of a `path`).
    const old = new Database(file)
    old.exec('CREATE TABLE traces (ref TEXT PRIMARY KEY, engagement_id TEXT, kind TEXT, data BLOB, ts INTEGER)')
    old.close()

    const db = openDatabase(file)
    expect(columns(db, 'traces')).toEqual(['id', 'engagement_id', 'kind', 'path', 'ts'])
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
