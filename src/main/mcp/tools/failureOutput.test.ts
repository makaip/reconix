// Failure/truncation output contract: an agent must be able to tell WHY a tool
// failed and WHETHER data was cut. These tests pin the additive fields without
// asserting on the exact success shape (which stays backwards compatible).
import { describe, expect, it } from 'vitest'
import { interactionTools } from './interaction'
import { navigationTools } from './navigation'
import { networkTools } from './network'
import { findingTools } from './findings'
import type { Tool, ToolContext } from '../tool'

function tool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

function pageCtx(expressionResult: string): ToolContext {
  return { cdp: { evaluate: async () => expressionResult } } as unknown as ToolContext
}

describe('click/fill report a reason instead of a bare ok:false', () => {
  it('click explains that no element matched', async () => {
    const click = tool(interactionTools, 'click')
    const out = (await click.execute(
      { selector: '#missing' },
      pageCtx(JSON.stringify({ error: 'no element matched selector' }))
    )) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('#missing')
    expect(out.nextStep).toContain('query_dom')
  })

  it('fill explains that no element matched', async () => {
    const fill = tool(interactionTools, 'fill')
    const out = (await fill.execute(
      { selector: '#missing', value: 'x' },
      pageCtx(JSON.stringify({ error: 'no element matched selector' }))
    )) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(out.reason).toContain('no element matched')
    expect(out.nextStep).toContain('query_dom')
  })
})

describe('truncating tools always report counts', () => {
  it('query_dom reports total/returned/omitted and a truncated flag', async () => {
    const query = tool(interactionTools, 'query_dom')
    const nodes = Array.from({ length: 50 }, (_, n) => ({ tag: 'a', id: String(n) }))
    const out = (await query.execute(
      { selector: 'a' },
      pageCtx(JSON.stringify({ total: 120, truncated: true, nodes }))
    )) as Record<string, unknown>
    expect(out.total).toBe(120)
    expect(out.returned).toBe(50)
    expect(out.omitted).toBe(70)
    expect(out.truncated).toBe(true)
    expect(String(out.note)).toContain('first 50')
  })

  it('query_dom notes an empty match set', async () => {
    const query = tool(interactionTools, 'query_dom')
    const out = (await query.execute(
      { selector: '#nope' },
      pageCtx(JSON.stringify({ total: 0, truncated: false, nodes: [] }))
    )) as Record<string, unknown>
    expect(out.returned).toBe(0)
    expect(out.truncated).toBe(false)
    expect(String(out.note)).toContain('no elements matched')
  })

  it('get_storage flags truncated values and counts the cut characters', async () => {
    const storage = tool(navigationTools, 'get_storage')
    const out = (await storage.execute(
      {},
      pageCtx(JSON.stringify({ localStorage: { token: 'a'.repeat(2500) }, sessionStorage: {} }))
    )) as Record<string, unknown>
    expect(out.truncatedAny).toBe(true)
    const counts = out.counts as {
      localStorage: { total: number; truncatedValues: number; omittedChars: number }
    }
    expect(counts.localStorage.total).toBe(1)
    expect(counts.localStorage.truncatedValues).toBe(1)
    expect(counts.localStorage.omittedChars).toBe(500)
    expect(String(out.note)).toContain('cut at 2000 chars')
  })

  it('list_forms notes an empty page', async () => {
    const forms = tool(navigationTools, 'list_forms')
    const out = (await forms.execute({}, pageCtx('[]'))) as Record<string, unknown>
    expect(out.total).toBe(0)
    expect(out.truncated).toBe(false)
    expect(String(out.note)).toContain('no forms found')
  })

  it('export_report reports total/returned/omitted when capping rows', async () => {
    const report = tool(findingTools, 'export_report')
    const rows = Array.from({ length: 250 }, (_, n) => ({ id: n }))
    const ctx = { history: { query: async () => rows } } as unknown as ToolContext
    const out = (await report.execute({}, ctx)) as Record<string, unknown>
    expect(out.count).toBe(250)
    expect(out.total).toBe(250)
    expect(out.returned).toBe(200)
    expect(out.omitted).toBe(50)
    expect(out.truncated).toBe(true)
    expect(String(out.note)).toContain('narrow the filter')
  })
})

describe('empty list results explain themselves', () => {
  it('get_network_log notes that nothing was captured', async () => {
    const log = tool(networkTools, 'get_network_log')
    const ctx = { network: { list: () => [], get: () => undefined } } as unknown as ToolContext
    const out = (await log.execute({}, ctx)) as Record<string, unknown>
    expect(out.total).toBe(0)
    expect(out.truncated).toBe(false)
    expect(String(out.note)).toContain('no requests captured')
  })

  it('get_network_log sets truncated when older entries are dropped', async () => {
    const log = tool(networkTools, 'get_network_log')
    const entries = Array.from({ length: 120 }, (_, n) => ({
      id: String(n),
      tabId: 1,
      method: 'GET',
      url: `https://app.example.com/${n}`,
      resourceType: 'xhr',
      startedAt: n,
      statusCode: 200
    }))
    const ctx = { network: { list: () => entries, get: () => undefined } } as unknown as ToolContext
    const out = (await log.execute({}, ctx)) as Record<string, unknown>
    expect(out.returned).toBe(50)
    expect(out.omitted).toBe(70)
    expect(out.truncated).toBe(true)
    expect(String(out.note)).toContain('most recent 50')
  })
})
