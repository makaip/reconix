// Renderer-facing trace contract (ARCHITECTURE §6.4). A "trace" is an opaque
// evidence blob — a screenshot, a captured request/response pair, or a raw
// trace — addressed by a `traceRef`, never inlined over the bridge by the MCP
// tools. The Traces panel reads these shapes to browse what the agent captured.

export type TraceKind = 'screenshot' | 'reqresp' | 'trace'

/** Metadata row for the panel list — no payload. */
export interface TraceSummary {
  ref: string
  kind: TraceKind
  /** Epoch ms the trace was stored. */
  ts: number
  bytes: number
}

/** A trace's contents for display. Binary traces (screenshots) arrive
 *  base64-encoded; text traces arrive as UTF-8. */
export interface TraceDetail extends TraceSummary {
  encoding: 'utf8' | 'base64'
  data: string
}
