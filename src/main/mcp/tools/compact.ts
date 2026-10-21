// compact_conversation (API.md §3.7 — findings & history). Checkpoints the
// engagement's own recorded history into one narrative so the orchestrator can
// stop re-reading query_log rows, and trims the stored params of old calls. This
// is Reconix-side history compaction only — the LLM's conversation window belongs
// to OpenCode and is untouched. Read-only in risk terms: it re-writes its own
// audit rows, never touches a target, so it declares no target().
import { defineTool, type Tool } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'
import { compactEngagement, getCompactionStore, type CompactOptions } from '../../compact'

const MAX_FILTER_LIMIT = 500

export type CompactConversationInput = CompactOptions

export interface CompactConversationOutput {
  summary: string
  rowsCompacted: number
  ref?: string
  storedAt: number
}

/** Optional plain-object filter, same shape query_log accepts. */
function optionalFilter(raw: unknown): CompactOptions['filter'] | undefined {
  const v = (raw as Record<string, unknown>).filter
  if (v === undefined) return undefined
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ToolInputError('"filter" must be an object')
  }
  const f = v as Record<string, unknown>
  const out: NonNullable<CompactOptions['filter']> = {}

  if (f.since !== undefined) {
    if (typeof f.since !== 'number' || !Number.isFinite(f.since) || f.since < 0) {
      throw new ToolInputError('"filter.since" must be a non-negative epoch-ms number')
    }
    out.since = f.since
  }
  for (const key of ['tool', 'kind'] as const) {
    const value = f[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length === 0) {
      throw new ToolInputError(`"filter.${key}" must be a non-empty string`)
    }
    out[key] = value
  }
  if (f.limit !== undefined) {
    if (typeof f.limit !== 'number' || !Number.isFinite(f.limit) || f.limit < 1) {
      throw new ToolInputError('"filter.limit" must be a positive number')
    }
    out.limit = Math.min(MAX_FILTER_LIMIT, Math.floor(f.limit))
  }
  return out
}

/** Optional non-negative duration (ms). */
function optionalDuration(raw: unknown, key: string): number | undefined {
  const v = (raw as Record<string, unknown>)[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new ToolInputError(`"${key}" must be a non-negative number of milliseconds`)
  }
  return Math.floor(v)
}

/** Optional positive row cap. */
function optionalRowCap(raw: unknown): number | undefined {
  const v = (raw as Record<string, unknown>).maxRowsToCompact
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
    throw new ToolInputError('"maxRowsToCompact" must be a positive number')
  }
  return Math.floor(v)
}

const compact_conversation = defineTool<CompactConversationInput, CompactConversationOutput>({
  name: 'compact_conversation',
  description:
    'Summarize the engagement’s tool-call/finding/approval history into a compact checkpoint narrative. Returns a compact summary plus how many old tool_call rows were compacted (params trimmed). Use it to checkpoint progress instead of re-reading query_log rows. Optionally store the summary as a trace (ref returned) for later reference.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: {
          since: { type: 'number', minimum: 0, description: 'Only history at/after this epoch-ms.' },
          tool: { type: 'string', description: 'Only tool calls for this tool name.' },
          kind: { type: 'string', description: 'Narrative slice hint (recorded for parity with query_log).' },
          limit: { type: 'number', minimum: 1, maximum: MAX_FILTER_LIMIT, description: 'Cap on rows described.' }
        },
        additionalProperties: false
      },
      compactOlderThanMs: {
        type: 'number',
        minimum: 0,
        description: 'Age window for rows to compact (default 24h).'
      },
      maxRowsToCompact: {
        type: 'number',
        minimum: 1,
        description: 'Max rows compacted in this pass (default 200).'
      },
      storeAs: {
        type: 'string',
        enum: ['trace', 'none'],
        description: "Store the narrative as a trace when 'trace' and return its ref."
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    required: ['summary', 'rowsCompacted', 'storedAt'],
    properties: {
      summary: { type: 'string' },
      rowsCompacted: { type: 'number' },
      ref: { type: 'string' },
      storedAt: { type: 'number' }
    }
  },
  parse: (raw) => {
    const storeAs = (raw as Record<string, unknown>).storeAs
    if (storeAs !== undefined && storeAs !== 'trace' && storeAs !== 'none') {
      throw new ToolInputError('"storeAs" must be one of: trace, none')
    }
    const out: CompactConversationInput = {}
    const filter = optionalFilter(raw)
    if (filter !== undefined) out.filter = filter
    const olderThanMs = optionalDuration(raw, 'compactOlderThanMs')
    if (olderThanMs !== undefined) out.compactOlderThanMs = olderThanMs
    const maxRows = optionalRowCap(raw)
    if (maxRows !== undefined) out.maxRowsToCompact = maxRows
    if (storeAs !== undefined) out.storeAs = storeAs as 'trace' | 'none'
    return out
  },
  // No target: the read/rewrite is engagement-global history, not a browser
  // target, so there is nothing for the pipeline's scope gate to check.
  target: () => undefined,
  execute: async (i, ctx): Promise<CompactConversationOutput> => {
    const store = getCompactionStore()
    if (!store) {
      throw new ToolExecError(
        'engagement history is unavailable on this surface: no history store is wired'
      )
    }

    const result = await compactEngagement(store.db, store.findings, ctx.engagementId, {
      filter: i.filter,
      compactOlderThanMs: i.compactOlderThanMs,
      maxRowsToCompact: i.maxRowsToCompact,
      storeAs: i.storeAs
    })

    // Storing the narrative as a trace belongs here, not in compact.ts: the
    // trace store is electron-side. A missing trace store is not fatal — the
    // summary is still returned, just without a ref.
    let ref: string | undefined
    if (i.storeAs === 'trace' && ctx.traces) {
      ref = String(await ctx.traces.save('trace', result.summary))
    }

    return {
      summary: result.summary,
      rowsCompacted: result.rowsCompacted,
      ...(ref === undefined ? {} : { ref }),
      storedAt: Date.now()
    }
  }
})

export const compactTools: Tool[] = [compact_conversation as Tool]
