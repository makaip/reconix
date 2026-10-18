// Types shared by the main process (session manager), preload and renderer.
// Mirrors the engagement state machine in arch.md §3.3 (Session & State Manager) and
// §5 (IPC & Communication Protocols).

export type RiskTier = 'read-only' | 'mutating' | 'destructive'

/** A callable tool as the Tool Registry (arch.md §6) will eventually expose it. */
export type ToolDescriptor = {
  name: string
  description: string
  riskTier: RiskTier
}

export type AgentTaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting-approval'
  | 'done'
  | 'denied'
  | 'failed'

export type AgentTask = {
  id: string
  title: string
  riskTier: RiskTier
  status: AgentTaskStatus
}

export type RunState = 'idle' | 'running' | 'paused'

export type AgentSessionState = {
  runId: string | null
  state: RunState
  goal: string | null
  scope: string | null
  tasks: AgentTask[]
}

export type StartAgentParams = {
  goal: string
  scope: string
}

export type ApprovalRequest = {
  approvalId: string
  taskId: string
  action: string
  riskTier: RiskTier
  diffPreview: string
}

export type ApprovalDecision = {
  approvalId: string
  decision: 'approve' | 'deny'
  // §6.1 `respondApproval` carries optional human edits to the gated action's params.
  // Text-only key/value map so it stays structured-cloneable and renders as text nodes.
  editedParams?: Record<string, string>
}

/** §6.1 `sendMessage` payload: a user message into the agent session. */
export type SendMessageParams = {
  text: string
}

// ---------------------------------------------------------------------------
// agent:event — the single transcript stream (arch.md §6.1, §5.A).
//
// One normalized, structured-cloneable event per transcript entry: plain data
// only (no functions/class instances) so it survives the contextBridge. Every
// variant carries a stable `id` and a monotonic `seq` ordering key; the renderer
// folds the stream into ordered transcript items. ALL text/args/results here are
// agent- or target-derived and MUST render as text nodes only (§5.A).
// ---------------------------------------------------------------------------

type AgentEventBase = {
  /** Stable, unique id for this event (React key, dedupe). */
  id: string
  /** Monotonic ordering key assigned by the emitter. */
  seq: number
  /** Emit time, ms since epoch. */
  ts: number
}

/** A human message echoed back into the transcript. */
export type UserMessageEvent = AgentEventBase & {
  kind: 'user-message'
  text: string
  /** Labels of any DOM/context attachments the user included. */
  context: string[]
}

/** Free-form agent reasoning/output text. */
export type ReasoningEvent = AgentEventBase & {
  kind: 'reasoning'
  text: string
}

/** The agent invoking a tool. `args` is a flat text map (no nested instances). */
export type ToolCallEvent = AgentEventBase & {
  kind: 'tool-call'
  callId: string
  tool: string
  riskTier: RiskTier
  args: Record<string, string>
}

/** The result of a previously emitted tool-call, keyed by `callId`. */
export type ToolResultEvent = AgentEventBase & {
  kind: 'tool-result'
  callId: string
  tool: string
  ok: boolean
  summary: string
}

/**
 * An inline approval request (arch.md §6.1 — approvals are events in the same
 * stream, not a separate modal). Re-emitted with an updated `status` when the
 * human decides, so the reducer can resolve it in place.
 */
export type ApprovalRequestEvent = AgentEventBase & {
  kind: 'approval-request'
  approvalId: string
  /** The tool-call this gates, if any. */
  callId?: string
  tool: string
  riskTier: RiskTier
  action: string
  diffPreview: string
  status: 'pending' | 'approved' | 'denied'
}

export type AgentEvent =
  | UserMessageEvent
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalRequestEvent

// The canonical finding type lives in ./findings (shared by the MCP-recorded
// findings panel and this legacy session manager). Re-exported here so existing
// `import { Finding } from '../shared/agent'` call sites keep resolving.
export type { Finding, FindingSeverity } from './findings'
