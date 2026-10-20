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
    if (!trace) {
      throw new ToolExecError(
        `No trace stored for ref ${i.ref} — capture evidence first (screenshot/collect_evidence), ` +
          'or resolve a ref returned by an earlier tool via get_trace'
      )
    }

    const bytes = trace.data.length
    const truncated = bytes > MAX_INLINE_BYTES
    const encoding = truncated ? null : trace.kind === 'screenshot' ? 'base64' : 'utf8'
    return {
      ref: trace.ref,
      kind: trace.kind,
      ts: trace.ts,
      bytes,
      total: bytes,
      // When over the cap no contents are inlined, so `returned` is 0 and the
      // whole trace counts as omitted.
      returned: truncated ? 0 : bytes,
      omitted: truncated ? bytes : 0,
      maxInlineBytes: MAX_INLINE_BYTES,
      encoding,
      data: truncated ? null : Buffer.from(trace.data).toString(encoding === 'base64' ? 'base64' : 'utf8'),
      truncated,
      note: truncated
        ? `trace is ${bytes} bytes, over the ${MAX_INLINE_BYTES}-byte inline cap — contents were not included. ` +
          'Use the trace metadata (kind/bytes) or a smaller capture (e.g. screenshot without fullPage) instead.'
        : undefined
    }
  }
})

export const evidenceTools: Tool[] = [get_trace as Tool]
