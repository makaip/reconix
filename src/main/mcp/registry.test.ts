import { describe, expect, it } from 'vitest'
import { ToolRegistry } from './registry'
import { InMemoryAuditLogger } from './audit'
import { defineTool } from './tool'
import type { ToolContext } from './tool'

function ctx(): ToolContext {
  return {
    engagementId: 'eng-1',
    scope: { config: {}, isInScope: () => true, assertInScope: () => {} }
  } as unknown as ToolContext
}

describe('ToolRegistry read cache still audits', () => {
  it('writes an intent + outcome row for every call, including cache hits', async () => {
    const registry = new ToolRegistry()
    let executes = 0
    registry.register(
      defineTool<Record<string, never>, { value: number }>({
        name: 'get_page_info',
        description: 'fake cacheable read',
        riskTier: 'R',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        parse: () => ({}),
        execute: async () => {
          executes++
          return { value: executes }
        }
      })
    )
    const audit = new InMemoryAuditLogger()
    const c = ctx()

    const first = await registry.call('get_page_info', {}, c, audit)
    const second = await registry.call('get_page_info', {}, c, audit)

    // The second call was served from cache (executor ran once) …
    expect(executes).toBe(1)
    expect(second.output).toEqual(first.output)
    // … but the audit trail has a row per call, not per execution.
    expect(audit.intents.size).toBe(2)
    expect(audit.outcomes.size).toBe(2)
    for (const outcome of audit.outcomes.values()) {
      expect(outcome.ok).toBe(true)
    }
  })

  it('records the resolved target on a cache hit', async () => {
    const registry = new ToolRegistry()
    registry.register(
      defineTool<{ url: string }, unknown>({
        name: 'get_dom_extract',
        description: 'fake cacheable read with a target',
        riskTier: 'R',
        inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
        outputSchema: { type: 'object' },
        parse: (raw) => ({ url: (raw as { url: string }).url }),
        target: (i) => i.url,
        execute: async () => ({ ok: true })
      })
    )
    const audit = new InMemoryAuditLogger()
    const c = ctx()

    await registry.call('get_dom_extract', { url: 'https://app.example.com/a' }, c, audit)
    await registry.call('get_dom_extract', { url: 'https://app.example.com/a' }, c, audit)

    const targets = [...audit.intents.values()].map((i) => i.target)
    expect(targets).toEqual(['https://app.example.com/a', 'https://app.example.com/a'])
  })
})
