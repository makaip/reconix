// The one code path every tool call takes (ARCHITECTURE §5.C rule 2 & 4):
//   parse (validate as hostile) → audit intent → scope-check → execute → audit outcome
// Nothing acts without an audit row; validation rejections and scope denials
// are both logged too — "Tool errors also produce ... an audit row" (API.md
// §4) draws no exception for malformed input. Approval gating for M/D tiers
// is handled UPSTREAM by OpenCode's permission config (keyed off riskTier) —
// by the time execute() runs, the human has already said yes. See API.md §2.2.

import type { AuditLogger } from './audit'
import type { Tool, ToolContext } from './tool'
import { ScopeError, ToolExecError, ToolInputError } from './errors'

export interface ToolCallResult {
  ok: boolean
  output?: unknown
  resultRef?: string
  error?: { code: string; message: string; retriable: boolean }
}

export async function invokeTool(
  tool: Tool,
  rawParams: unknown,
  ctx: ToolContext,
  audit: AuditLogger
): Promise<ToolCallResult> {
  // 1. Validate as hostile. Even a structurally invalid call gets an audit
  // row — we log the raw (unresolved) params since there's no parsed input,
  // and no target since none could be derived.
  let input: unknown
  try {
    input = tool.parse(rawParams)
  } catch (err) {
    const e = err as ToolInputError
    const toolCallId = await audit.recordIntent({
      engagementId: ctx.engagementId,
      tool: tool.name,
      params: rawParams,
      riskTier: tool.riskTier
    })
    await audit.recordOutcome(toolCallId, { ok: false, error: e.message })
    return fail(e.code ?? 'TOOL_INPUT', e.message, false)
  }

  const target = tool.target?.(input)

  // 2. Record intent (resolved params + target + tier) before anything happens.
  const toolCallId = await audit.recordIntent({
    engagementId: ctx.engagementId,
    tool: tool.name,
    params: input,
    target,
    riskTier: tool.riskTier
  })

  // 3. Semantic scope check. Denials are an audited outcome, not a silent drop.
  try {
    ctx.scope.assertInScope(target)
  } catch (err) {
    const e = err as ScopeError
    await audit.recordOutcome(toolCallId, { ok: false, error: e.message })
    return fail(e.code, e.message, false)
  }

  // 4. Execute, then record the outcome no matter how it settles.
  try {
    const output = await tool.execute(input, ctx)
    await audit.recordOutcome(toolCallId, { ok: true })
    return { ok: true, output }
  } catch (err) {
    const e = err as ToolExecError
    const message = e?.message ?? String(err)
    await audit.recordOutcome(toolCallId, { ok: false, error: message })
    return fail(e?.code ?? 'TOOL_EXEC', message, e?.retriable ?? false)
  }
}

function fail(code: string, message: string, retriable: boolean): ToolCallResult {
  return { ok: false, error: { code, message, retriable } }
}
