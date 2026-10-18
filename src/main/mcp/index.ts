// MCP server seam (ARCHITECTURE §6.2). The registry is transport-agnostic; the
// real @modelcontextprotocol/sdk server plugs in here, exposing listTools() /
// callTool() to OpenCode. Built-in OpenCode tools are disabled by D, so this is
// the agent's ONLY path to act.

import type { AuditLogger } from './audit'
import type { ToolAccess } from '../../shared/contracts'
import type { ToolContext, ToolDescriptor } from './tool'
import { ToolRegistry } from './registry'
import { allTools, mvpTools } from './tools'
import type { ToolCallResult } from './pipeline'

export interface McpServer {
  listTools(): ToolDescriptor[]
  tierMap(): Record<string, ToolDescriptor['riskTier']>
  callTool(name: string, params: unknown): Promise<ToolCallResult>
  getToolAccess(): ToolAccess[]
  setEnabledTools(names: readonly string[]): ToolAccess[]
}

export interface BuildMcpOptions {
  audit: AuditLogger
  context: ToolContext
  /** 'mvp' = the Appendix MVP subset (default); 'all' = full catalog. */
  surface?: 'mvp' | 'all'
}

export function buildMcpServer(opts: BuildMcpOptions): McpServer {
  const registry = new ToolRegistry()
  registry.registerAll(opts.surface === 'all' ? allTools : mvpTools)
  const descriptors = registry.descriptors()
  const knownNames = new Set(descriptors.map((tool) => tool.name))
  let enabledNames = new Set(knownNames)

  const getToolAccess = (): ToolAccess[] =>
    descriptors.map(({ name, description, riskTier }) => ({
      name,
      description,
      riskTier,
      enabled: enabledNames.has(name)
    }))

  return {
    listTools: () => descriptors.filter((tool) => enabledNames.has(tool.name)),
    tierMap: () =>
      Object.fromEntries(
        Object.entries(registry.tierMap()).filter(([name]) => enabledNames.has(name))
      ),
    callTool: (name, params) => {
      if (!enabledNames.has(name)) {
        return Promise.resolve({
          ok: false,
          error: { code: 'TOOL_DISABLED', message: `Function disabled by user: ${name}`, retriable: false }
        })
      }
      return registry.call(name, params, opts.context, opts.audit)
    },
    getToolAccess,
    setEnabledTools: (names) => {
      enabledNames = new Set(names.filter((name) => knownNames.has(name)))
      return getToolAccess()
    }
  }
}

export { ToolRegistry } from './registry'
export type { Tool, ToolContext } from './tool'
export { buildMcpServer as default }
