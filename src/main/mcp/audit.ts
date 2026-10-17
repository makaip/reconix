// Audit write-through seam (ARCHITECTURE §6.4). Dev 2 (B) owns the real SQLite
// implementation; the tool layer writes through this narrow interface. The
// agent can never obtain one of these — it is Main-side only.

import type { EngagementId, RiskTier, ToolCallId } from '../../shared/contracts'

export interface AuditIntent {
  engagementId: EngagementId
  tool: string
  params: unknown
  target?: string
  riskTier: RiskTier
}

export interface AuditOutcome {
  ok: boolean
  resultRef?: string
  error?: string
}

export interface AuditLogger {
  /** Append the intent row (tool_calls) before execution; returns its id. */
  recordIntent(intent: AuditIntent): Promise<ToolCallId>
  /** Append the outcome once execution settles. Append-only; never updates. */
  recordOutcome(toolCallId: ToolCallId, outcome: AuditOutcome): Promise<void>
}

// In-memory stand-in for Phase-1 mocking. Swap for B's SQLite logger at integration.
export class InMemoryAuditLogger implements AuditLogger {
  readonly intents = new Map<ToolCallId, AuditIntent>()
  readonly outcomes = new Map<ToolCallId, AuditOutcome>()
  private seq = 0

  async recordIntent(intent: AuditIntent): Promise<ToolCallId> {
    const id = `tc_${++this.seq}`
    this.intents.set(id, intent)
    return id
  }

  async recordOutcome(toolCallId: ToolCallId, outcome: AuditOutcome): Promise<void> {
    this.outcomes.set(toolCallId, outcome)
  }
}
