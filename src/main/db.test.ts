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
    expect(columns(db, 'findings')).toEqual(['id', 'engagement_id', 'schema_json', 'evidence_ref', 'status', 'ts'])
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
