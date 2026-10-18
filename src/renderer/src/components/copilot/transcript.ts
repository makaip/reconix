// Renderer-side transcript model. Unlike shared/contracts.ts's AgentEvent
// (one normalized event at a time), this is the accumulated shape useCopilot
// builds up for Message.tsx to render — each assistant turn is an ordered
// list of parts (text, reasoning, tool calls) rather than a single string,
// so tool calls and reasoning show up inline where they actually happened
// instead of being dropped.

import type { RiskTier } from '../../../../shared/contracts'

export type ToolPartStatus = 'pending' | 'ok' | 'error'

export interface ToolPart {
  kind: 'tool'
  callId: string
  tool: string
  params: unknown
  riskTier: RiskTier
  target?: string
  status: ToolPartStatus
  error?: string
  /** Flattened tool output (stdout, file text, fetched page …), set from the
   *  matching tool.result. Absent while pending or when there was none. */
  output?: string
  /** Heuristic: OpenCode's own subagent delegation (orchestrator -> @evaluator
   *  etc.) surfaces as a tool call by name (e.g. "task"/"agent") rather than
   *  a distinct event type — no dedicated subagent-spawn event exists on the
   *  wire today. Flag it so the UI can call it out instead of pretending
   *  it's an ordinary tool. */
  isSubagent: boolean
  approval?: { id: string; status: 'pending' | 'approved' | 'denied' }
}

export interface ReasoningPart {
  kind: 'reasoning'
  text: string
}

export interface TextPart {
  kind: 'text'
  text: string
}

export type TranscriptPart = TextPart | ReasoningPart | ToolPart

export type CopilotMessage =
  | { id: string; role: 'user'; context: string[]; text: string; status: 'sent' | 'queued' | 'failed' }
  | { id: string; role: 'assistant'; parts: TranscriptPart[] }

const SUBAGENT_TOOL_NAME = /task|agent|subagent|delegate/i

export function isSubagentTool(tool: string): boolean {
  return SUBAGENT_TOOL_NAME.test(tool)
}

const BROWSER_TOOL_NAME = /(?:^|_)(navigate|get_page_info|get_cookies|screenshot|eval_in_page|click|fill|dispatch_input|query_dom|set_dom|set_emulation|get_dom_extract|list_forms|list_links|get_headers)$/i

export function isBrowserTool(tool: string): boolean {
  return BROWSER_TOOL_NAME.test(tool)
}
