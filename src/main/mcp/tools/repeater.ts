// API.md §3.10 — Repeater. Exposes the app's saved-request store + gated send
// (§11.1) to the copilot. Send is tier M; list/diff are read-only.
import { defineTool, type Tool } from '../tool'
import { ToolExecError } from '../errors'

const repeater_list = defineTool<Record<string, never>, unknown>({
  name: 'repeater_list',
  description: 'List saved repeater requests.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    if (!ctx.repeater) throw new ToolExecError('repeater not available')
    return ctx.repeater.list()
  }
})

const repeater_save = defineTool<{ raw: unknown }, unknown>({
  name: 'repeater_save',
  description: 'Save or update a repeater request ({ name, tags, request }).',
  riskTier: 'R',
  inputSchema: { type: 'object', required: ['raw'], properties: { raw: { type: 'object' } }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const r = raw as { raw?: unknown }
    return { raw: r?.raw }
  },
  execute: async (i, ctx) => {
    if (!ctx.repeater) throw new ToolExecError('repeater not available')
    return ctx.repeater.save(i.raw)
  }
})

const repeater_send = defineTool<{ id: string }, unknown>({
  name: 'repeater_send',
  description: 'Send a saved repeater request through the gated replayer.',
  riskTier: 'M',
  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ id: (raw as { id?: unknown }).id as string }),
  execute: async (i, ctx) => {
    if (!ctx.repeater) throw new ToolExecError('repeater not available')
    return ctx.repeater.run(i.id)
  }
})

export const repeaterTools: Tool[] = [
  repeater_list as Tool,
  repeater_save as Tool,
  repeater_send as Tool
]
