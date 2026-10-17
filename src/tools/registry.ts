// Mock implementation of the ToolRegistry registration surface (§6.2, §5.C
// rule 1) for standalone exercise of Dev 1's 5.E tools outside Dev 3's real
// MCP server. Pure in-memory map — no network, no filesystem.

import type { CapabilityTool, ToolRegistry } from '../shared/tools'

export function createMockToolRegistry(): ToolRegistry {
  const tools = new Map<string, CapabilityTool<unknown, unknown>>()

  return {
    register<TInput, TOutput>(tool: CapabilityTool<TInput, TOutput>): void {
      if (tools.has(tool.name)) {
        throw new Error(`tool already registered: ${tool.name}`)
      }
      tools.set(tool.name, tool as unknown as CapabilityTool<unknown, unknown>)
    },
    get(name: string): CapabilityTool<unknown, unknown> | undefined {
      return tools.get(name)
    },
    list() {
      return Array.from(tools.values()).map(({ name, description, riskTier }) => ({
        name,
        description,
        riskTier
      }))
    }
  }
}
