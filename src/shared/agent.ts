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
}

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high'

export type Finding = {
  id: string
  title: string
  severity: FindingSeverity
  taskId: string
}
