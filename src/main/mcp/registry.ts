// Tool registry — the allowlist made concrete (ARCHITECTURE §5.C rule 1).
// Dev 1's 5.E custom tools register here exactly like Dev 3's own, inheriting
// the same pipeline. There is no other way to add a capability.

import type { AuditLogger } from './audit'
import type { Tool, ToolContext, ToolDescriptor } from './tool'
import { invokeTool, type ToolCallResult } from './pipeline'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()
  private readonly cache = new Map<string, { value: ToolCallResult; ts: number }>()
  private readonly CACHEABLE = new Set(['get_page_info', 'get_dom_extract', 'get_cookies', 'get_headers'])
  private readonly CACHE_TTL_MS = 30_000

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** The advertised surface OpenCode sees — plus the tier map B needs for
   *  permission config (API.md §3 header / §2.2). */
  descriptors(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      riskTier: t.riskTier
    }))
  }

  tierMap(): Record<string, ToolDescriptor['riskTier']> {
    const map: Record<string, ToolDescriptor['riskTier']> = {}
    for (const t of this.tools.values()) map[t.name] = t.riskTier
    return map
  }

  async call(
    name: string,
    rawParams: unknown,
    ctx: ToolContext,
    audit: AuditLogger
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        ok: false,
        error: { code: 'UNKNOWN_TOOL', message: `no such tool: ${name}`, retriable: false }
      }
    }
    const key = name + ':' + JSON.stringify(rawParams ?? {})
    if (this.CACHEABLE.has(name)) {
      const cached = this.cache.get(key)
      if (cached && Date.now() - cached.ts < this.CACHE_TTL_MS) {
        // A cache hit is still a tool call by the agent. Skipping the audit
        // write here would leave the trail with no row for a read that plainly
        // happened (ARCHITECTURE §6.4: "nothing acts without an audit row"), so
        // the hit is recorded as intent + outcome like any other call.
        await this.auditCacheHit(tool, rawParams, ctx, audit, cached.value)
        return cached.value
      }
    } else {
      // Any state-changing call invalidates the read-only cache.
      this.cache.clear()
    }
    const result = await invokeTool(tool, rawParams, ctx, audit)
    if (this.CACHEABLE.has(name) && result.ok) {
      this.cache.set(key, { value: result, ts: Date.now() })
    }
    return result
  }

  /** Write the audit rows for a cache hit: intent (resolved params + target +
   *  tier) before returning, then the outcome. The execution is skipped, not
   *  the bookkeeping. */
  private async auditCacheHit(
    tool: Tool,
    rawParams: unknown,
    ctx: ToolContext,
    audit: AuditLogger,
    cached: ToolCallResult
  ): Promise<void> {
    // parse() is pure and already succeeded when the entry was cached; fall
    // back to the raw params rather than dropping the row if that ever changes.
    let input: unknown = rawParams
    let target: string | undefined
    try {
      const parsed = tool.parse(rawParams)
      input = parsed
      target = tool.target?.(parsed)
    } catch {
      /* keep raw params / no target — the row is still written */
    }
    const toolCallId = await audit.recordIntent({
      engagementId: ctx.engagementId,
      tool: tool.name,
      params: input,
      target,
      riskTier: tool.riskTier
    })
    await audit.recordOutcome(
      toolCallId,
      cached.ok
        ? { ok: true, resultRef: cached.resultRef }
        : { ok: false, error: cached.error?.message ?? 'cached failure' }
    )
  }
}
