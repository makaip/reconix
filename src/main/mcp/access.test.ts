import { describe, expect, it } from 'vitest'
import { buildMcpServer } from './index'
import type { AuditLogger } from './audit'
import type { ToolContext } from './tool'

describe('MCP function access', () => {
  it('filters disabled functions and blocks direct calls', async () => {
    const server = buildMcpServer({
      audit: {} as AuditLogger,
      context: {} as ToolContext,
      surface: 'all'
    })
    const all = server.getToolAccess()
    const enabled = all[0]
    expect(enabled).toBeDefined()

    server.setEnabledTools([enabled.name, 'not_a_real_function'])

    expect(server.listTools().map((tool) => tool.name)).toEqual([enabled.name])
    expect(server.getToolAccess().filter((tool) => tool.enabled).map((tool) => tool.name)).toEqual([enabled.name])

    const disabled = all.find((tool) => tool.name !== enabled.name)
    expect(disabled).toBeDefined()
    await expect(server.callTool(disabled!.name, {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'TOOL_DISABLED', retriable: false }
    })
  })
})
