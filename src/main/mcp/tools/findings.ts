// API.md §3.7 — Findings & history. record_finding writes the findings table
// (NOT the audit log) and requires an evidence ref. query_log is the agent's
// ONLY history access — a narrow structured query, never a DB handle.
import { defineTool, type Tool } from '../tool'
import { str } from '../validate'

const record_finding = defineTool<{ schema: unknown; evidenceRef: string }, unknown>({
  name: 'record_finding',
  description: 'Record an evidence-backed finding for human review.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['schema', 'evidenceRef'],
    properties: { schema: { type: 'object' }, evidenceRef: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { findingId: { type: 'string' } } },
  parse: (raw) => {
    const r = raw as { schema?: unknown }
    if (typeof r?.schema !== 'object' || r.schema === null) {
      throw new Error('"schema" must be an object')
    }
    return { schema: r.schema, evidenceRef: str(raw, 'evidenceRef') }
  },
  execute: async (i, ctx) => ({ findingId: await ctx.findings.record(i.schema, i.evidenceRef) })
})

const query_log = defineTool<{ filter: unknown }, unknown>({
  name: 'query_log',
  description: 'Structured read of the engagement history (the agent’s only history access).',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['filter'],
    properties: { filter: { type: 'object' } },
    additionalProperties: false
  },
  outputSchema: { type: 'array' },
  parse: (raw) => {
    const r = raw as { filter?: unknown }
    return { filter: r?.filter ?? {} }
  },
  execute: async (i, ctx) => ctx.history.query(i.filter)
})

const export_report = defineTool<{ filter?: unknown }, unknown>({
  name: 'export_report',
  description: 'Export engagement findings as a Markdown report.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: { filter: { type: 'object' } }, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: (raw) => {
    const r = raw as { filter?: unknown }
    return { filter: r?.filter ?? {} }
  },
  execute: async (i, ctx) => {
    const rows = await ctx.history.query(i.filter)
    const lines = ['# Findings Report', '', `Total: ${rows.length}`, '']
    for (const r of rows as any[]) lines.push(`- ${JSON.stringify(r)}`)
    return { markdown: lines.join('\\n'), count: rows.length }
  }
})

export const findingTools: Tool[] = [record_finding as Tool, query_log as Tool, export_report as Tool]
