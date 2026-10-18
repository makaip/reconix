import { describe, expect, it } from 'vitest'
import { ToolExecError } from '../errors'
import type { ToolContext, TraceRecord, TraceStore } from '../tool'
import { evidenceTools } from './evidence'

const getTrace = evidenceTools.find((t) => t.name === 'get_trace')!

const ctxWith = (record: TraceRecord | null): ToolContext =>
  ({ traces: { save: async () => 'x', get: () => record } as TraceStore }) as unknown as ToolContext

const record = (kind: TraceRecord['kind'], data: Uint8Array): TraceRecord => ({
  ref: 'trace_1',
  kind,
  ts: 5,
  data
})

describe('get_trace', () => {
  it('returns UTF-8 contents for a text trace', async () => {
    const out = (await getTrace.execute(
      { ref: 'trace_1' },
      ctxWith(record('trace', Buffer.from('hello')))
    )) as Record<string, unknown>

    expect(out).toMatchObject({
      ref: 'trace_1',
      kind: 'trace',
      encoding: 'utf8',
      data: 'hello',
      bytes: 5,
      truncated: false
    })
  })

  it('base64-encodes a screenshot', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const out = (await getTrace.execute(
      { ref: 'trace_1' },
      ctxWith(record('screenshot', png))
    )) as Record<string, unknown>

    expect(out.encoding).toBe('base64')
    expect(out.data).toBe(png.toString('base64'))
  })

  it('omits contents over the inline cap', async () => {
    const big = Buffer.alloc(256 * 1024 + 1, 0x41)
    const out = (await getTrace.execute(
      { ref: 'trace_1' },
      ctxWith(record('trace', big))
    )) as Record<string, unknown>

    expect(out.data).toBeNull()
    expect(out.encoding).toBeNull()
    expect(out.truncated).toBe(true)
    expect(out.bytes).toBe(big.length)
  })

  it('throws for an unknown ref', async () => {
    await expect(getTrace.execute({ ref: 'trace_999' }, ctxWith(null))).rejects.toBeInstanceOf(
      ToolExecError
    )
  })
})
