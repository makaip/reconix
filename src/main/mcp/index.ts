// MCP server seam (ARCHITECTURE §6.2). The registry is transport-agnostic; the
// real @modelcontextprotocol/sdk server plugs in here, exposing listTools() /
// callTool() to OpenCode. Built-in OpenCode tools are disabled by D, so this is
// the agent's ONLY path to act.

import type { AuditLogger } from './audit'
import type { ToolContext, ToolDescriptor } from './tool'
import { ToolRegistry } from './registry'
import { allTools, mvpTools } from './tools'
import type { ToolCallResult } from './pipeline'

export interface McpServer {
  listTools(): ToolDescriptor[]
  tierMap(): Record<string, ToolDescriptor['riskTier']>
  callTool(name: string, params: unknown): Promise<ToolCallResult>
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

  return {
    listTools: () => registry.descriptors(),
    tierMap: () => registry.tierMap(),
    callTool: (name, params) => registry.call(name, params, opts.context, opts.audit)
  }
}

export { ToolRegistry } from './registry'
export type { Tool, ToolContext } from './tool'
export { buildMcpServer as default }
