// API.md §3.6 — Verify & evidence. get_trace resolves an opaque `traceRef`
// (from screenshot / evidence collection) back into its stored contents. Text
// traces come back as UTF-8; binary traces (screenshots) as base64. Anything
// over the inline cap returns metadata only, so a full-page screenshot can't
// flood the model context.
import { ToolExecError } from '../errors'
import { defineTool, type Tool } from '../tool'
import { str } from '../validate'

/** Cap on inlined trace bytes (~256 KiB pre-encoding). */
const MAX_INLINE_BYTES = 256 * 1024

const get_trace = defineTool<{ ref: string }, unknown>({
  name: 'get_trace',
  description:
    'Fetch a stored evidence trace by ref. Returns metadata plus contents (text as-is, binary as base64), or metadata only when over the inline size cap.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['ref'],
    properties: { ref: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object' },
  parse: (raw) => ({ ref: str(raw, 'ref') }),
  execute: async (i, ctx) => {
    const trace = ctx.traces.get(i.ref)
    if (!trace) throw new ToolExecError(`No trace stored for ref ${i.ref}`)

    const bytes = trace.data.length
    const truncated = bytes > MAX_INLINE_BYTES
    const encoding = truncated ? null : trace.kind === 'screenshot' ? 'base64' : 'utf8'
    return {
      ref: trace.ref,
      kind: trace.kind,
      ts: trace.ts,
      bytes,
      encoding,
      data: truncated ? null : Buffer.from(trace.data).toString(encoding === 'base64' ? 'base64' : 'utf8'),
      truncated
    }
  }
})

export const evidenceTools: Tool[] = [get_trace as Tool]
