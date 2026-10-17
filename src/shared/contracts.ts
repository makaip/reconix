// Shared main-process contracts. Mirrors ARCHITECTURE.md §6 and API.md §1/§3.
// Changing a type here is a §6 contract change — version it (CONTRACTS_VERSION).

export const CONTRACTS_VERSION = '0.1.0'

// ─── Risk tiers (API.md §3 / ARCHITECTURE §5.C) ───────────────────────────────
// R read-only (auto) · P page-mutating, sandbox-only (auto)
// M mutating (approval) · D destructive (approval + rate-limit)
export type RiskTier = 'R' | 'P' | 'M' | 'D'

export const AUTO_TIERS: ReadonlySet<RiskTier> = new Set<RiskTier>(['R', 'P'])
export const GATED_TIERS: ReadonlySet<RiskTier> = new Set<RiskTier>(['M', 'D'])

// ─── Scope config (§6.5) — one object, two enforcement layers ─────────────────
export interface ScopeConfig {
  allowed_hosts: string[] // exact or leading-wildcard, e.g. "*.example.com"
  allowed_cidrs: string[] // e.g. "10.0.0.0/8" — enforced at D's network floor
  denied: string[] // host patterns that always lose, checked first
  rate_limits: Record<string, number> // host -> req/s; enforced at D's proxy
}

export interface Policy {
  autoApprove: RiskTier[] // tiers that never raise a permission request
  redactCookies: boolean
  maxToolCallsPerTurn: number
}

// ─── IDs (Main-issued, correlate IPC ↔ store rows, API.md §4) ─────────────────
export type EngagementId = string
export type ToolCallId = string
export type ApprovalId = string
export type TraceRef = string // opaque handle into traces (6.4); never an inline blob

// ─── Normalized agent event (API.md §1.3) — the single transcript stream ──────
export type AgentEvent =
  | { kind: 'message.delta'; messageId: string; role: 'assistant'; text: string }
  | { kind: 'reasoning.delta'; messageId: string; text: string }
  | {
      kind: 'tool.call'
      callId: ToolCallId
      tool: string
      params: unknown
      riskTier: RiskTier
      target?: string
    }
  | { kind: 'tool.result'; callId: ToolCallId; ok: boolean; resultRef?: string; error?: string }
  | {
      kind: 'approval.request'
      approvalId: ApprovalId
      callId: ToolCallId
      tool: string
      params: unknown
      riskTier: 'M' | 'D'
      target?: string
    }
  | { kind: 'approval.resolved'; approvalId: ApprovalId; decision: ApprovalDecision }
  | { kind: 'turn.done'; messageId: string }
  | { kind: 'error'; scope: 'session' | 'tool' | 'model'; message: string }

export type ApprovalDecision = 'approve' | 'deny' | 'edit'

export interface ServerStatus {
  state: 'starting' | 'ready' | 'reconnecting' | 'down'
  detail?: string
}

// Engine boot status — `opencode serve` + the MCP tool server coming up at
// app launch, before any chat session exists. Distinct from ServerStatus
// above (which tracks an active OpenCode session's connection state).
export type EngineStatus = { status: 'starting' } | { status: 'ready' } | { status: 'error'; error: string }

// ─── Error envelope (API.md §4) ───────────────────────────────────────────────
export interface ErrorEnvelope {
  error: { code: string; message: string; retriable: boolean }
}
