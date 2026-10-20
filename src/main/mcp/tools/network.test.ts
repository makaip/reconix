import { describe, expect, it } from 'vitest'
import { networkTools } from './network'
import { invokeTool } from '../pipeline'
import type { AuditLogger } from '../audit'
import type { Tool, ToolContext } from '../tool'
import type { HttpRequestSpec } from '../cdp'
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

describe('replay_request sends through the target session with overrides', () => {
  function replayCtx(cap: { spec?: HttpRequestSpec }): ToolContext {
    return {
      engagementId: 'eng-1',
      scope: { config: {}, isInScope: () => true, assertInScope: () => {} },
      cdp: {
        sendRequest: async (spec: HttpRequestSpec) => {
          cap.spec = spec
          return {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            body: 'x'.repeat(2000),
            bodyBytes: 2000,
            durationMs: 5
          }
        }
      },
      traces: { save: async () => 'trace://reqresp/1' }
    } as unknown as ToolContext
  }

  it('merges overrides: changes method/body and strips a header via null', async () => {
    const cap: { spec?: HttpRequestSpec } = {}
    const res = await invokeTool(
      tool('replay_request'),
      {
        base: {
          url: 'https://app.example.com/x',
          method: 'GET',
          headers: { authorization: 'Bearer t', 'x-keep': '1' }
        },
        overrides: { method: 'POST', body: '{"a":1}', headers: { authorization: null } }
      },
      replayCtx(cap),
      audit
    )
    expect(res.ok).toBe(true)
    expect(cap.spec?.method).toBe('POST')
    expect(cap.spec?.body).toBe('{"a":1}')
    expect(cap.spec?.headers).toEqual({ 'x-keep': '1' }) // authorization removed
  })

  it('clamps the inline body but reports true byte size and a bodyRef', async () => {
    const cap: { spec?: HttpRequestSpec } = {}
    const res = await invokeTool(
      tool('replay_request'),
      { base: { url: 'https://app.example.com/x' } },
      replayCtx(cap),
      audit
    )
    expect(res.ok).toBe(true)
    const out = res.output as {
      response: { body: string; bodyBytes: number }
      bodyRef: string
    }
    expect(out.response.bodyBytes).toBe(2000)
    expect(out.response.body).toContain('chars]') // clamp marker present
    expect(out.response.body.length).toBeLessThan(2000)
    expect(out.bodyRef).toBe('trace://reqresp/1')
  })

  it('scope target is the override url when present', () => {
    const t = tool('replay_request')
    const parsed = t.parse({
      base: { url: 'https://base.example.com/x' },
      overrides: { url: 'https://override.example.com/y' }
    })
    expect(t.target?.(parsed)).toBe('https://override.example.com/y')
  })

  it('rejects a non-http(s) base url before sending', async () => {
    const cap: { spec?: HttpRequestSpec } = {}
    const res = await invokeTool(
      tool('replay_request'),
      { base: { url: 'file:///etc/passwd' } },
      replayCtx(cap),
      audit
    )
    expect(res.ok).toBe(false)
    expect(cap.spec).toBeUndefined() // never reached the send primitive
  })
})

describe('replay_batch sweeps many variants in one call', () => {
  function batchCtx(opts: {
    sent: HttpRequestSpec[]
    inScope?: (url: string) => boolean
    bodyFor?: (url: string) => string
    status?: (url: string) => number
    maxReplayBatch?: number
  }): ToolContext {
    return {
      engagementId: 'eng-1',
      policy: {
        autoApprove: [],
        redactCookies: false,
        maxToolCallsPerTurn: 100,
        maxReplayBatch: opts.maxReplayBatch ?? 20
      },
      scope: {
        config: {},
        isInScope: (t?: string) => (opts.inScope ? opts.inScope(t ?? '') : true),
        assertInScope: () => {}
      },
      cdp: {
        sendRequest: async (spec: HttpRequestSpec) => {
          opts.sent.push(spec)
          const body = opts.bodyFor ? opts.bodyFor(spec.url) : 'ok'
          return {
            status: opts.status ? opts.status(spec.url) : 200,
            statusText: 'OK',
            headers: {},
            body,
            bodyBytes: Buffer.byteLength(body),
            durationMs: 1
          }
        }
      },
      traces: { save: async () => 'trace://reqresp/x' }
    } as unknown as ToolContext
  }

  it('merges each variant onto base and returns one row per variant, in order', async () => {
    const sent: HttpRequestSpec[] = []
    const res = await invokeTool(
      tool('replay_batch'),
      {
        base: { url: 'https://app.example.com/', headers: { 'x-base': '1' } },
        variants: [
          { url: 'https://app.example.com/a' },
          { url: 'https://app.example.com/b', method: 'POST', body: '{}' }
        ]
      },
      batchCtx({ sent }),
      audit
    )
    expect(res.ok).toBe(true)
    const out = res.output as { count: number; results: Array<Record<string, unknown>> }
    expect(out.count).toBe(2)
    expect(out.results.map((r) => r.url)).toEqual([
      'https://app.example.com/a',
      'https://app.example.com/b'
    ])
    // base headers carried onto every variant; per-variant method/body applied
    expect(sent.every((s) => s.headers?.['x-base'] === '1')).toBe(true)
    expect(sent[1].method).toBe('POST')
    expect(sent[1].body).toBe('{}')
  })

  it('does not send out-of-scope variants but still reports them', async () => {
    const sent: HttpRequestSpec[] = []
    const res = await invokeTool(
      tool('replay_batch'),
      {
        base: { url: 'https://app.example.com/' },
        variants: [{ url: 'https://app.example.com/ok' }, { url: 'https://evil.example.net/x' }]
      },
      batchCtx({ sent, inScope: (u) => u.includes('app.example.com') }),
      audit
    )
    expect(res.ok).toBe(true)
    const out = res.output as { results: Array<{ url: string; error?: string }> }
    expect(sent.map((s) => s.url)).toEqual(['https://app.example.com/ok']) // evil never sent
    expect(out.results[1].error).toContain('out of scope')
  })

  it('flags variants whose status or size differs from the first response', async () => {
    const res = await invokeTool(
      tool('replay_batch'),
      {
        base: { url: 'https://app.example.com/' },
        variants: [{ url: 'https://app.example.com/1' }, { url: 'https://app.example.com/2' }]
      },
      batchCtx({
        sent: [],
        status: (u) => (u.endsWith('/2') ? 500 : 200),
        bodyFor: () => 'x'
      }),
      audit
    )
    expect(res.ok).toBe(true)
    const out = res.output as {
      results: Array<{ anomalous?: boolean }>
      summary: { statuses: Record<string, number>; errors: number }
    }
    expect(out.results[0].anomalous).toBe(false)
    expect(out.results[1].anomalous).toBe(true) // 500 != baseline 200
    expect(out.summary.statuses['200']).toBe(1)
    expect(out.summary.statuses['500']).toBe(1)
  })

  it('rejects a batch over the default size cap', async () => {
    const variants = Array.from({ length: 25 }, (_, n) => ({ url: `https://app.example.com/${n}` }))
    const res = await invokeTool(
      tool('replay_batch'),
      { base: { url: 'https://app.example.com/' }, variants },
      batchCtx({ sent: [] }),
      audit
    )
    expect(res.ok).toBe(false)
    expect(res.error?.message).toContain('max 20')
  })

  it('honors a configurable cap from engagement policy', async () => {
    const sent: HttpRequestSpec[] = []
    const three = Array.from({ length: 3 }, (_, n) => ({ url: `https://app.example.com/${n}` }))
    // cap lowered to 2 → a 3-variant batch is rejected and nothing is sent
    const low = await invokeTool(
      tool('replay_batch'),
      { base: { url: 'https://app.example.com/' }, variants: three },
      batchCtx({ sent, maxReplayBatch: 2 }),
      audit
    )
    expect(low.ok).toBe(false)
    expect(low.error?.message).toContain('max 2')
    expect(sent).toHaveLength(0)

    // cap raised to 50 → the same 3-variant batch runs
    const high = await invokeTool(
      tool('replay_batch'),
      { base: { url: 'https://app.example.com/' }, variants: three },
      batchCtx({ sent, maxReplayBatch: 50 }),
      audit
    )
    expect(high.ok).toBe(true)
    expect(sent).toHaveLength(3)
  })
})

describe('network input validation is reported as TOOL_INPUT, not TOOL_EXEC', () => {
  it('rejects a non-array variants field as an input error', async () => {
    const res = await invokeTool(
      tool('replay_batch'),
      { base: { url: 'https://app.example.com/' }, variants: 'nope' },
      ctxWith([]),
      audit
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })

  it('rejects a malformed variant entry as an input error with its index', async () => {
    const res = await invokeTool(
      tool('replay_batch'),
      { base: { url: 'https://app.example.com/' }, variants: [{ headers: { a: 1 } }] },
      ctxWith([]),
      audit
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
    expect(res.error?.message).toContain('variants[0]')
  })

  it('rejects a non-string header value in base as an input error', async () => {
    const res = await invokeTool(
      tool('replay_request'),
      { base: { url: 'https://app.example.com/', headers: { a: 1 } } },
      ctxWith([]),
      audit
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })

  it('rejects a non-http(s) override url as an input error before sending', async () => {
    const res = await invokeTool(
      tool('replay_request'),
      { base: { url: 'https://app.example.com/' }, overrides: { url: 'file:///etc/passwd' } },
      ctxWith([]),
      audit
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })
})
