// API.md §3.7 — Findings & history. record_finding writes the findings table
// (NOT the audit log) and requires an evidence ref. query_log is the agent's
// ONLY history access — a narrow structured query, never a DB handle.
import { defineTool, type Tool } from '../tool'
import { str } from '../validate'
import { ToolInputError } from '../errors'

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
      throw new ToolInputError('"schema" must be an object describing the finding (title, severity, description, evidence)')
    }
    return { schema: r.schema, evidenceRef: str(raw, 'evidenceRef') }
  },
  execute: async (i, ctx) => {
    if (ctx.traces && typeof (ctx.traces as { get?: (id: string) => unknown }).get === 'function') {
      const trace = (ctx.traces as { get: (id: string) => unknown }).get(i.evidenceRef)
      if (!trace) {
        throw new ToolInputError(
          `evidenceRef "${i.evidenceRef}" does not resolve to a captured trace — ` +
            'capture evidence first (collect_evidence or screenshot) and pass its traceRef, ' +
            'or verify the ref with get_trace'
        )
      }
    }
    return { findingId: await ctx.findings.record(i.schema, i.evidenceRef) }
  }
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
    const r = (raw ?? {}) as { filter?: unknown }
    if (r.filter !== undefined && (typeof r.filter !== 'object' || r.filter === null || Array.isArray(r.filter))) {
      throw new ToolInputError('"filter" must be an object')
    }
    return { filter: (r.filter as Record<string, unknown>) ?? {} }
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
    const r = (raw ?? {}) as { filter?: unknown }
    if (r.filter !== undefined && (typeof r.filter !== 'object' || r.filter === null || Array.isArray(r.filter))) {
      throw new ToolInputError('"filter" must be an object')
    }
    return { filter: (r.filter as Record<string, unknown>) ?? {} }
  },
  execute: async (i, ctx) => {
    const rows = await ctx.history.query(i.filter)
    const capped = (rows as any[]).slice(0, 200)
    const omitted = rows.length - capped.length
    const lines = ['# Findings Report', '', `Total: ${rows.length}`, '']
    for (const r of capped) lines.push(`- ${JSON.stringify(r).slice(0, 2000)}`)
    if (omitted > 0) lines.push(`... ${omitted} more rows omitted`)
    return {
      markdown: lines.join('\n'),
      count: rows.length,
      total: rows.length,
      returned: capped.length,
      omitted,
      truncated: omitted > 0,
      note:
        omitted > 0
          ? `report includes ${capped.length} of ${rows.length} rows; narrow the filter or raise the cap to include the rest`
          : rows.length === 0
            ? 'no findings matched the filter — record one with record_finding or widen the filter'
            : undefined
    }
  }
})

export const findingTools: Tool[] = [record_finding as Tool, query_log as Tool, export_report as Tool]
