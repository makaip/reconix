// Shared main-process contracts. Mirrors ARCHITECTURE.md §6 and API.md §1/§3.
// Changing a type here is a §6 contract change — version it (CONTRACTS_VERSION).

export const CONTRACTS_VERSION = '0.6.0'

// ─── Risk tiers (API.md §3 / ARCHITECTURE §5.C) ───────────────────────────────
// R read-only (auto) · P page-mutating, sandbox-only (auto)
// M mutating (approval) · D destructive (approval + rate-limit)
export type RiskTier = 'R' | 'P' | 'M' | 'D'

/** A model-facing Reconix function and whether the current user allows it. */
export interface ToolAccess {
  name: string
  description: string
  riskTier: RiskTier
  enabled: boolean
}

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

// ─── Scope status (renderer-facing projection of §6.5) ────────────────────────
// Read-only view of the engagement's authorized scope, for the URL bar's
// "In scope" badge and the status bar's scope summary. Derived from the same
// scope.json the replays/proxy enforce, so the badge can't disagree with what
// the agent is actually allowed to reach.
export interface ScopeStatus {
  /** Allowed host patterns (exact or leading-wildcard, e.g. "*.example.com"). */
  hosts: string[]
  /** Human-readable one-liner for the status bar. "none" when no scope is loaded. */
  summary: string
}

/** True iff `hostname` matches any allowed host pattern. Mirrors the main-process
 *  ScopeChecker's wildcard matching so the badge and enforcement never diverge. */
export function hostInScope(hostname: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // ".example.com"
      return hostname === pattern.slice(2) || hostname.endsWith(suffix)
    }
    return hostname === pattern
  })
}

// ─── Egress proxy status (renderer-facing) ────────────────────────────────────
// The container egress proxy (5.D) isn't managed by the app, so there is no
// runtime health surface to report — only the configured address, if any.
export interface ProxyStatus {
  /** host:port the agent's egress is routed through; null when unconfigured. */
  address: string | null
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
  | {
      kind: 'tool.result'
      callId: ToolCallId
      ok: boolean
      resultRef?: string
      error?: string
      /** Flattened tool output (stdout, file text, fetched page …) for the
       *  transcript. Absent when the tool produced no textual output; may be
       *  truncated for very large results. */
      output?: string
    }
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
// 'starting' and 'error' are the one-time boot states of the LOCAL engine
// (`opencode serve` + the MCP tool server). 'ready' and 'offline' are the live
// state of the remote MODEL backend the orchestrator runs on, which can come
// and go independently of boot: 'ready' = reachable, 'offline' = booted fine
// but the model provider is not responding (recoverable; keeps retrying).
export type EngineStatus =
  | { status: 'starting' }
  | { status: 'ready' }
  | { status: 'offline'; error?: string }
  | { status: 'error'; error: string }

// ─── Error envelope (API.md §4) ───────────────────────────────────────────────
export interface ErrorEnvelope {
  error: { code: string; message: string; retriable: boolean }
}

// ─── Usage / cost / latency (cost-latency-dashboard) ──────────────────────────
// Counts and timing ONLY — never prompt or response text. Deliberately kept
// separate from AgentEvent so the transcript stream stays lean and the meter
// cannot leak content into the UI. See docs/plan: cost-latency-dashboard.md.

/** Which part of the pipeline a call belongs to — the model-tiering breakdown. */
export type AgentRole = 'orchestrator' | 'dom-analyzer' | 'subagent' | 'unknown'

/** One tool call's wall-clock duration, paired from tool.call -> tool.result. */
export interface ToolLatency {
  tool: string
  callId: string
  ms: number
  ok: boolean
}

/** One agent turn (or one ambient call, e.g. a DOM-parser refresh). */
export interface TurnUsage {
  /** assistant messageId when known, else a synthetic id. */
  id: string
  /** Owning OpenCode session id, or '' for an ambient call we can't attribute. */
  sessionId: string
  role: AgentRole
  /** "provider/model". */
  model: string
  startedAt: number
  /** First streamed token (TTFT); undefined when the turn produced none. */
  firstTokenAt?: number
  finishedAt?: number
  inputTokens?: number
  outputTokens?: number
  /** Cost reported by OpenCode itself, when available; else computed locally. */
  reportedCostUsd?: number
  toolCallCount: number
  toolErrorCount: number
  toolLatencies: ToolLatency[]
  error?: boolean
}

export interface ModelRollup {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  p50Ms: number | null
  p95Ms: number | null
}

export interface RoleRollup {
  role: AgentRole
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface ToolRollup {
  tool: string
  calls: number
  errors: number
  p50Ms: number | null
  p95Ms: number | null
}

export interface UsageRollups {
  byModel: ModelRollup[]
  byRole: RoleRollup[]
  byTool: ToolRollup[]
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  costUsd: number
  turns: number
  /** How many background DOM-parser refreshes ran (the hidden recurring cost). */
  parserRefreshes: number
}

export interface UsageSnapshot {
  /** Most-recent-last, capped by the meter's ring buffer. */
  turns: TurnUsage[]
  /** Turns still being assembled (in-flight), so the UI can show live TTFT. */
  activeTurns: TurnUsage[]
  rollups: UsageRollups
  totals: UsageTotals
}
