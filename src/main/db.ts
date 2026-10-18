// The §6.4 engagement store: one SQLite database for every persisted artifact —
// findings, traces, and the tool-call audit log — so they share a single
// connection instead of contending over the same file. Backed by
// node-sqlite3-wasm (a WASM build of SQLite), which needs no native module to
// recompile per platform. Schema is created on open; callers own the lifecycle
// and must close() it.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'node-sqlite3-wasm'

// tool_calls carries the intent row (params/target/tier) and the outcome fills
// the same row once execution settles: ok/result_ref/error/finished_ts. Rows are
// never deleted, so the log stays a faithful, append-only-by-row record.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS findings (
    id            TEXT PRIMARY KEY,
    engagement_id TEXT,
    schema_json   TEXT NOT NULL,
    evidence_ref  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    ts            INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS traces (
    ref           TEXT PRIMARY KEY,
    engagement_id TEXT,
    kind          TEXT NOT NULL,
    data          BLOB NOT NULL,
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
`

/**
 * @param dbPath SQLite file to open/create. Omit for an in-memory DB (tests).
 */
export function openDatabase(dbPath?: string): Database {
  if (dbPath) mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath ?? ':memory:')
  db.exec(SCHEMA)
  return db
}
