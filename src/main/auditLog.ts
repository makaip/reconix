// SQLite implementation of the audit write-through seam (ARCHITECTURE §6.4). The
// pipeline records an intent row before every tool call and an outcome once it
// settles, so `tool_calls` is the engagement's durable activity log — the thing
// query_log/history reads back. Replaces InMemoryAuditLogger in the live bridge
// (smoke.ts still uses the in-memory one for its isolated checks).
import type { Database } from 'node-sqlite3-wasm'
import type { AuditIntent, AuditLogger, AuditOutcome } from './mcp/audit'

/** Ids are `tc_<n>`; recover the sequence so restored ids never collide. */
function callSeq(id: string): number {
  const match = /^tc_(\d+)$/.exec(id)
  return match ? Number(match[1]) : 0
}

export function createAuditLogger(db: Database): AuditLogger {
  let seq = 0
  for (const row of db.all('SELECT id FROM tool_calls')) {
    seq = Math.max(seq, callSeq(String((row as Record<string, unknown>).id)))
  }

  return {
    recordIntent: async (intent: AuditIntent) => {
      const id = `tc_${++seq}`
      db.run(
        'INSERT INTO tool_calls (id, engagement_id, tool, params_json, target, risk_tier, started_ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          intent.engagementId,
          intent.tool,
          JSON.stringify(intent.params ?? null),
          intent.target ?? null,
          intent.riskTier,
          Date.now()
        ]
      )
      return id
    },
    recordOutcome: async (toolCallId, outcome: AuditOutcome) => {
      db.run(
        'UPDATE tool_calls SET ok = ?, result_ref = ?, error = ?, finished_ts = ? WHERE id = ?',
        [outcome.ok ? 1 : 0, outcome.resultRef ?? null, outcome.error ?? null, Date.now(), toolCallId]
      )
    }
  }
}
