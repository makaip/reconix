import { Database } from 'node-sqlite3-wasm'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS engagements (
    id            TEXT PRIMARY KEY,
    goal          TEXT NOT NULL,
    scope_json    TEXT,
    policy_json   TEXT,
    started_at    INTEGER NOT NULL,
    stopped_at    INTEGER,
    status        TEXT NOT NULL DEFAULT 'stopped'
  );
  CREATE TABLE IF NOT EXISTS findings (
    id            TEXT PRIMARY KEY,
    engagement_id TEXT,
    schema_json   TEXT NOT NULL,
    evidence_ref  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    ts            INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS traces (
    id            TEXT PRIMARY KEY,
    engagement_id TEXT,
    kind          TEXT NOT NULL,
    path          TEXT NOT NULL,
    ts            INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tool_calls (
    id            TEXT PRIMARY KEY,
    engagement_id TEXT,
    tool          TEXT NOT NULL,
    params_json   TEXT NOT NULL,
    target        TEXT,
    risk_tier     TEXT NOT NULL,
    ok            INTEGER,
    result_ref    TEXT,
    error         TEXT,
    started_ts    INTEGER NOT NULL,
    finished_ts   INTEGER
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id                 TEXT PRIMARY KEY,
    tool_call_id       TEXT,
    decision           TEXT NOT NULL,
    edited_params_json TEXT,
    actor              TEXT,
    ts                 INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS raw_events (
    id            TEXT PRIMARY KEY,
    engagement_id TEXT,
    session_id    TEXT,
    type          TEXT,
    data_json     TEXT,
    ts            INTEGER
  );
  CREATE TABLE IF NOT EXISTS repeater_saved (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    tags_json       TEXT NOT NULL DEFAULT '[]',
    request_json    TEXT NOT NULL,
    responses_json  TEXT NOT NULL DEFAULT '[]',
    updated_at      INTEGER NOT NULL
  );
`

function migrate(db: Database): void {
  // drop legacy traces shape if present
  try {
    const cols = db.all("PRAGMA table_info(traces)") as { name: string }[]
    if (cols.some((c) => c.name === 'data')) {
      db.exec('DROP TABLE traces')
    }
  } catch {
    // ignore
  }
}

export function openDatabase(dbPath?: string): Database {
  if (dbPath) mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath ?? ':memory:')
  migrate(db)
  db.exec(SCHEMA)
  return db
}
