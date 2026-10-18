import { describe, expect, it } from 'vitest'
import { networkTools } from './network'
import { invokeTool } from '../pipeline'
import type { AuditLogger } from '../audit'
import type { Tool, ToolContext } from '../tool'
import type { CapturedRequest } from '../../../shared/tabs'

const audit: AuditLogger = {
  recordIntent: async () => 'call-1',
  recordOutcome: async () => {}
} as unknown as AuditLogger

function ctxWith(entries: CapturedRequest[]): ToolContext {
  return {
    engagementId: 'eng-1',
    scope: { config: {}, isInScope: () => true, assertInScope: () => {} },
    network: {
      list: () => entries,
      get: (id: string) => entries.find((e) => e.id === id)
    }
  } as unknown as ToolContext
}

function tool(name: string): Tool {
  const t = networkTools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

function req(id: number, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: String(id),
    tabId: 1,
    method: 'GET',
    url: `https://app.example.com/r${id}`,
    resourceType: 'xhr',
    startedAt: id,
    statusCode: 200,
    responseHeaders: { 'set-cookie': ['a'.repeat(5000)] },
    ...extra
  }
}

describe('get_network_log is compact and bounded', () => {
  it('omits header maps and caps to the most recent 50, with a cursor', async () => {
    const entries = Array.from({ length: 120 }, (_, n) => req(n + 1))
    const res = await invokeTool(tool('get_network_log'), {}, ctxWith(entries), audit)
    expect(res.ok).toBe(true)
    const out = res.output as {
      entries: Array<Record<string, unknown>>
      total: number
      omitted: number
      nextCursor: string | null
    }
    expect(out.total).toBe(120)
    expect(out.entries.length).toBe(50)
    expect(out.omitted).toBe(70)
    // the most recent entry is the cursor for the next page
    expect(out.nextCursor).toBe('120')
    // no header maps leaked into the list rows
    expect(out.entries[0]).not.toHaveProperty('responseHeaders')
    expect(out.entries[0]).not.toHaveProperty('requestHeaders')
    // the whole compact log easily fits the per-result budget
    expect(JSON.stringify(out).length).toBeLessThan(8000)
  })
})

describe('get_request clamps oversized header values', () => {
  it('trims long header values but keeps the row', async () => {
    const res = await invokeTool(tool('get_request'), { id: '1' }, ctxWith([req(1)]), audit)
    expect(res.ok).toBe(true)
    const out = res.output as { responseHeaders: Record<string, string[]> }
    expect(out.responseHeaders['set-cookie'][0]).toContain('chars]')
    expect(out.responseHeaders['set-cookie'][0].length).toBeLessThan(5000)
  })

  it('fails clearly for an unknown id', async () => {
    const res = await invokeTool(tool('get_request'), { id: 'nope' }, ctxWith([req(1)]), audit)
    expect(res.ok).toBe(false)
    expect(res.error?.message).toContain('no request with id')
  })
})
