// Tool registry — the allowlist made concrete (ARCHITECTURE §5.C rule 1).
// Dev 1's 5.E custom tools register here exactly like Dev 3's own, inheriting
// the same pipeline. There is no other way to add a capability.

import type { AuditLogger } from './audit'
import type { Tool, ToolContext, ToolDescriptor } from './tool'
import { invokeTool, type ToolCallResult } from './pipeline'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

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
      // An unknown name is not a passthrough — it is a hard reject.
      return {
        ok: false,
        error: { code: 'UNKNOWN_TOOL', message: `no such tool: ${name}`, retriable: false }
      }
    }
    return invokeTool(tool, rawParams, ctx, audit)
  }
}
