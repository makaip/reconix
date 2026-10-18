// Context budget guards (ARCHITECTURE §5.C). The orchestrator runs on a small
// local context window (see opencode.json: limit.context 20480). A single tool
// result that serializes to tens of thousands of tokens — e.g. a full network
// log with every header map — overflows that window, and OpenCode reports the
// overflow as `session.execution.failed`, not as a tool error. So bounding tool
// output is a RELIABILITY measure, not just tidiness: it keeps one noisy page
// from killing the whole turn. These caps are the single enforced ceiling; each
// tool should still return a sensibly small shape on its own.

/** Hard ceiling on a single serialized tool result. ~8k chars ≈ ~2k tokens,
 *  leaving the window for the system prompt, tool catalog and conversation. */
export const MAX_TOOL_RESULT_CHARS = 8000

/** Default max elements a list-shaped tool returns before it must truncate. */
export const MAX_LIST_ITEMS = 50

/** Max characters of a single string field we echo back (header values, text,
 *  outerHTML snippets). Long values are the other way outputs balloon. */
export const MAX_FIELD_CHARS = 512

/** Truncate a string to `max`, appending a visible marker when it was cut so
 *  the agent knows the value is partial rather than genuinely short. */
export function clampString(value: string, max = MAX_FIELD_CHARS): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…[+${value.length - max} chars]`
}

/** Cap an array to `max` items, returning the slice plus how many were dropped
 *  so the tool can surface a `{ truncated, omitted }` hint to the agent. */
export function capArray<T>(items: T[], max = MAX_LIST_ITEMS): { items: T[]; omitted: number } {
  if (items.length <= max) return { items, omitted: 0 }
  return { items: items.slice(0, max), omitted: items.length - max }
}

/**
 * Final safety net applied to every tool's serialized output by the MCP server.
 * If the JSON is within budget it is returned unchanged; otherwise it is cut to
 * the ceiling with a trailing marker. Truncating raw JSON yields invalid JSON on
 * purpose — the marker makes the truncation unmistakable to the model, which is
 * safer than silently dropping fields and letting it reason on partial data it
 * believes is complete.
 */
export function clampToolResult(serialized: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (serialized.length <= max) return serialized
  const kept = serialized.slice(0, max)
  return `${kept}\n\n…[output truncated: ${serialized.length - max} more chars omitted to fit the context window. Narrow the query (e.g. use sinceId / an id lookup) for detail.]`
}
