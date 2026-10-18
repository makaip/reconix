// Audit write-through seam (ARCHITECTURE §6.4). Dev 2 (B) owns the real SQLite
// implementation; the tool layer writes through this narrow interface. The
// agent can never obtain one of these — it is Main-side only.

import type { ApprovalDecision, ApprovalId, EngagementId, RiskTier, ToolCallId } from '../../shared/contracts'

export interface AuditIntent {
  /** Null when no engagement scope is loaded; the call is still logged. */
  engagementId: EngagementId | null
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

/** A human decision on a gated action (the `approvals` table, §6.4). Append-only. */
export interface AuditApproval {
  approvalId: ApprovalId
  /** The gated tool call, when known. OpenCode's permission model keys off
   *  (action, resources), not a tool-call id, so this is usually null. */
  toolCallId?: ToolCallId | null
  decision: ApprovalDecision
  /** Edited params for an 'edit' decision; absent in the Copilot relay path. */
  editedParams?: unknown
  /** Who decided. The app has no auth yet, so callers pass a stable role label. */
  actor?: string
}

export interface AuditLogger {
  /** Append the intent row (tool_calls) before execution; returns its id. */
  recordIntent(intent: AuditIntent): Promise<ToolCallId>
  /** Append the outcome once execution settles. Append-only; never updates. */
  recordOutcome(toolCallId: ToolCallId, outcome: AuditOutcome): Promise<void>
  /** Append a human approval decision (approvals). Append-only; never updates. */
  recordApproval(approval: AuditApproval): Promise<ApprovalId>
}

// In-memory stand-in for Phase-1 mocking. Swap for B's SQLite logger at integration.
export class InMemoryAuditLogger implements AuditLogger {
  readonly intents = new Map<ToolCallId, AuditIntent>()
  readonly outcomes = new Map<ToolCallId, AuditOutcome>()
  readonly approvals: AuditApproval[] = []
  private seq = 0

  async recordIntent(intent: AuditIntent): Promise<ToolCallId> {
    const id = `tc_${++this.seq}`
    this.intents.set(id, intent)
    return id
  }

  async recordOutcome(toolCallId: ToolCallId, outcome: AuditOutcome): Promise<void> {
    this.outcomes.set(toolCallId, outcome)
  }

  async recordApproval(approval: AuditApproval): Promise<ApprovalId> {
    this.approvals.push(approval)
    return approval.approvalId
  }
}
