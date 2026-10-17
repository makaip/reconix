// API.md §3.1 — Session & scope (tier R). Pure reads, no target.
import { defineTool, type Tool } from '../tool'

const get_scope = defineTool<Record<string, never>, unknown>({
  name: 'get_scope',
  description: 'Return the current engagement scope config.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => ctx.scope.config
})

const get_engagement_state = defineTool<Record<string, never>, unknown>({
  name: 'get_engagement_state',
  description: 'Return engagementId, current url/phase, and running counts.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const info = await ctx.cdp.pageInfo()
    return { engagementId: ctx.engagementId, url: info.url, phase: 'active' }
  }
})

export const sessionTools: Tool[] = [get_scope, get_engagement_state] as Tool[]
