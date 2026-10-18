// Tool definition shape (ARCHITECTURE §6.2). Every capability the agent has is
// one of these; a capability that is not a Tool cannot be expressed.

import type { EngagementId, Policy, RiskTier, TraceRef } from '../../shared/contracts'
import type { CapturedRequest } from '../../shared/tabs'
import type { CdpDriver } from './cdp'
import type { JsonSchema } from './validate'
import type { ScopeEnforcer } from './scope'

// Sinks the handlers need, beyond the driver. Audit is NOT here — the pipeline
// owns audit so a handler can never skip it.
export type TraceKind = 'screenshot' | 'reqresp' | 'trace'
/** A stored trace, read back for the agent via get_trace. `data` is the raw
 *  bytes (text traces decode as UTF-8, screenshots as PNG, etc.). */
export interface TraceRecord {
  ref: string
  kind: TraceKind
  ts: number
  data: Uint8Array
}
export interface TraceStore {
  save(kind: TraceKind, data: Buffer | string): Promise<TraceRef>
  /** Resolve a ref produced by save(); null when it isn't in the store. */
  get(ref: TraceRef): TraceRecord | null
}
export interface FindingSink {
  record(schema: unknown, evidenceRef: string): Promise<string> // -> findingId (findings table)
}
export interface HistoryReader {
  query(filter: unknown): Promise<unknown[]> // backs query_log; never a DB handle
}
/** Backs get_network_log/get_request. Read-only — never a send primitive
 *  (that's replay_request, gated separately). Implementations scope `list`
 *  to whatever tab is "current" for the caller (see copilot.ts). */
export interface NetworkReader {
  list(sinceId?: string): CapturedRequest[]
  get(id: string): CapturedRequest | undefined
}

export interface ToolContext {
  engagementId: EngagementId
  scope: ScopeEnforcer
  policy: Policy
  cdp: CdpDriver
  traces: TraceStore
  findings: FindingSink
  history: HistoryReader
  network: NetworkReader
}

export interface Tool<I = unknown, O = unknown> {
  name: string
  description: string
  riskTier: RiskTier
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  /** Hostile structural validation. Throws ToolInputError on malformed input. */
  parse(raw: unknown): I
  /** Scope-relevant target (URL/host) for the pipeline to enforce, if any. */
  target?(input: I): string | undefined
  execute(input: I, ctx: ToolContext): Promise<O>
}

// Helper to keep tool definitions terse and well-typed.
export function defineTool<I, O>(t: Tool<I, O>): Tool<I, O> {
  return t
}

// MCP wire descriptor (what the server advertises to OpenCode).
export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  riskTier: RiskTier
}
