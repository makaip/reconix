// API.md §3.10 — Repeater. Exposes the app's saved-request store + gated send
// (§11.1) to the copilot. Send is tier M; list/diff are read-only.
import { defineTool, type Tool } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'

const repeater_list = defineTool<Record<string, never>, unknown>({
  name: 'repeater_list',
  description: 'List saved repeater requests.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    if (!ctx.repeater) {
      throw new ToolExecError(
        'repeater not available in this build/surface — use replay_request to send an ad-hoc request instead'
      )
    }
    return ctx.repeater.list()
  }
})

const repeater_save = defineTool<{ raw: unknown }, unknown>({
  name: 'repeater_save',
  description: 'Save or update a repeater request ({ name, tags, request }).',
  // A write (state mutation) but no egress — tier P, not R.
  riskTier: 'P',
  inputSchema: { type: 'object', required: ['raw'], properties: { raw: { type: 'object' } }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const r = raw as { raw?: unknown }
    if (typeof r?.raw !== 'object' || r.raw === null || Array.isArray(r.raw)) {
      throw new ToolInputError('"raw" must be an object: { name, tags?, request: { url, method?, headers?, body? } }')
    }
    return { raw: r.raw }
  },
  execute: async (i, ctx) => {
    if (!ctx.repeater) {
      throw new ToolExecError(
        'repeater not available in this build/surface — use replay_request to send an ad-hoc request instead'
      )
    }
    const saved = ctx.repeater.save(i.raw)
    if (saved === null) {
      throw new ToolExecError(
        'repeater_save: invalid payload or unknown id — expected { name, tags?, request: { url, method?, headers?, body? } }; ' +
          'call repeater_list to see saved ids',
        false
      )
    }
    return saved
  }
})

const repeater_send = defineTool<{ id: string }, unknown>({
  name: 'repeater_send',
  description: 'Send a saved repeater request through the gated replayer.',
  riskTier: 'M',
  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const id = (raw as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') throw new ToolInputError('"id" must be a non-empty string')
    return { id }
  },
  execute: async (i, ctx) => {
    if (!ctx.repeater) {
      throw new ToolExecError(
        'repeater not available in this build/surface — use replay_request to send an ad-hoc request instead'
      )
    }
    const result = await ctx.repeater.run(i.id)
    if (result === null) {
      throw new ToolExecError(
        `repeater_send: no saved request with id ${i.id} — call repeater_list for valid ids, or save one with repeater_save`,
        false
      )
    }
    return result
  }
})

export const repeaterTools: Tool[] = [
  repeater_list as Tool,
  repeater_save as Tool,
  repeater_send as Tool
]
