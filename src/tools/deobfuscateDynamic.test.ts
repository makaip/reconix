import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { deobfuscateDynamicTool } from './deobfuscateDynamic'
import {
  normalizeHarnessDump,
  validateDynamicTrace,
  TRACE_SCHEMA_VERSION,
  type DynamicTrace
} from './deobfuscateTrace'

const tool = deobfuscateDynamicTool

function run(input: Record<string, unknown>) {
  return invokeTool(tool, input)
}

/** A minimal harness-shaped dump, as `.opencode/tools/deobfuscate_harness.js` emits. */
function dump(entries: unknown[]) {
  return { status: 'dumped', entries }
}

describe('deobfuscate_dynamic — normalizer', () => {
  it('maps harness field aliases into normalized records', () => {
    const trace = normalizeHarnessDump(
      dump([
        { t: 1, kind: 'eval', code: 'var a = 1;', result: '[undefined]' },
        { t: 2, kind: 'function', body: 'return 1' },
        { t: 3, kind: 'document.write', html: '<script>x</script>' },
        { t: 4, kind: 'setTimeout', code: 'go()', delay: 10 },
        { t: 5, kind: 'String.fromCharCode', input: [104, 105], result: 'hi' },
        { t: 6, kind: 'atob', input: 'aGk=', result: 'hi' }
      ])
    )
    expect(trace.schemaVersion).toBe(TRACE_SCHEMA_VERSION)
    expect(trace.records).toHaveLength(6)
    expect(trace.records[1].code).toBe('return 1')
    expect(trace.records[2].code).toBe('<script>x</script>')
    expect(trace.records[4].codes).toEqual([104, 105])
    expect(trace.records[5].result).toBe('hi')
  })

  it('accepts the raw JSON string form', () => {
    const trace = normalizeHarnessDump(JSON.stringify(dump([
      { t: 1, kind: 'eval', code: 'x' }
    ])))
    expect(trace.records).toHaveLength(1)
    expect(validateDynamicTrace(trace).ok).toBe(true)
  })

  it('treats an install acknowledgement as an empty trace', () => {
    const trace = normalizeHarnessDump({ status: 'installed', entries: 0 })
    expect(trace.records).toHaveLength(0)
    expect(trace.notes?.join(' ')).toContain('install acknowledgement')
  })

  it('maps unknown hook kinds to custom and notes it', () => {
    const trace = normalizeHarnessDump(dump([{ t: 1, kind: 'mystery', result: 'x' }]))
    expect(trace.records[0].kind).toBe('custom')
    expect(trace.notes?.join(' ')).toContain('unknown hook kind')
  })

  it('marks records truncated when a field carries the ellipsis marker', () => {
    const trace = normalizeHarnessDump(dump([{ t: 1, kind: 'eval', code: 'abc\u2026' }]))
    expect(trace.records[0].truncated).toBe(true)
  })

  it('reads the harness `codes` field plus envelope phase/dropped', () => {
    const trace = normalizeHarnessDump({
      status: 'dumped',
      schemaVersion: 1,
      phase: 'pre-document',
      dropped: 3,
      entries: [
        { t: 1, kind: 'String.fromCharCode', codes: [104, 105], result: 'hi' },
        { t: 2, kind: 'eval', code: 'x' }
      ]
    })
    expect(trace.records[0].codes).toEqual([104, 105])
    expect(trace.records[0].phase).toBe('pre-document')
    expect(trace.records[1].phase).toBe('pre-document')
    expect(trace.notes?.join(' ')).toContain('dropped 3')
  })

  it('preserves call-site attribution when present', () => {
    const trace = normalizeHarnessDump(
      dump([{ t: 1, kind: 'eval', code: 'x', stack: 'at foo (a.js:1)' }])
    )
    expect(trace.records[0].stack).toBe('at foo (a.js:1)')
  })
})

describe('deobfuscate_dynamic — validation', () => {
  it('rejects input without exactly one of trace/dump', () => {
    expect(() => run({})).toThrow(ToolInputError)
    expect(() =>
      run({ trace: { schemaVersion: 1, records: [] }, dump: {} })
    ).toThrow(ToolInputError)
  })

  it('rejects a trace with an unsupported schemaVersion', () => {
    expect(() => run({ trace: { schemaVersion: 2, records: [] } })).toThrow(ToolInputError)
  })

  it('rejects an unknown hook kind', () => {
    expect(() =>
      run({ trace: { schemaVersion: 1, records: [{ t: 1, kind: 'nope' }] } })
    ).toThrow(ToolInputError)
  })

  it('rejects non-finite timestamps and oversized arrays', () => {
    expect(() =>
      run({ trace: { schemaVersion: 1, records: [{ t: 'x', kind: 'eval' }] } })
    ).toThrow(ToolInputError)
    expect(() =>
      run({ trace: { schemaVersion: 1, records: 'nope' } })
    ).toThrow(ToolInputError)
  })

  it('rejects invalid filter knobs', () => {
    const records = [{ t: 1, kind: 'eval', code: 'x' }]
    expect(() => run({ trace: { schemaVersion: 1, records }, kinds: ['nope'] })).toThrow(
      ToolInputError
    )
    expect(() => run({ trace: { schemaVersion: 1, records }, classes: ['nope'] })).toThrow(
      ToolInputError
    )
    expect(() => run({ trace: { schemaVersion: 1, records }, minLength: -1 })).toThrow(
      ToolInputError
    )
    expect(() => run({ trace: { schemaVersion: 1, records }, maxDepth: 0 })).toThrow(
      ToolInputError
    )
  })
})

describe('deobfuscate_dynamic — analysis', () => {
  it('recursively deobfuscates an eval payload through the static engine', () => {
    const result = run({
      dump: dump([{ t: 1, kind: 'eval', code: "var a = atob('aGVsbG8=');" }])
    })
    expect(result.status).toBe('ok')
    expect(result.findings).toHaveLength(1)
    const finding = result.findings[0]
    expect(finding.class).toBe('eval')
    expect(finding.static).toBeDefined()
    expect(finding.static?.transformed).toContain('"hello"')
  })

  it('skips static analysis when recurse is false', () => {
    const result = run({
      recurse: false,
      dump: dump([{ t: 1, kind: 'eval', code: "var a = atob('aGVsbG8=');" }])
    })
    expect(result.findings[0].static).toBeUndefined()
    expect(result.findings[0].payload).toBe("var a = atob('aGVsbG8=');")
  })

  it('reconstructs a payload from char codes when no result is present', () => {
    const result = run({
      recurse: false,
      dump: dump([{ t: 1, kind: 'String.fromCharCode', input: [104, 101, 108, 108, 111] }])
    })
    expect(result.findings[0].payload).toBe('hello')
  })

  it('dedupes identical payloads but still counts every kind', () => {
    const result = run({
      recurse: false,
      dump: dump([
        { t: 1, kind: 'eval', code: 'same()' },
        { t: 2, kind: 'eval', code: 'same()' },
        { t: 3, kind: 'atob', input: 'aGk=', result: 'hi' }
      ])
    })
    expect(result.findings).toHaveLength(2)
    expect(result.byKind.eval).toBe(2)
    expect(result.byKind.atob).toBe(1)
  })

  it('aggregates indicators from decoder results', () => {
    const result = run({
      recurse: false,
      dump: dump([
        { t: 1, kind: 'atob', input: 'x', result: 'fetch("https://evil.example.com/beacon")' }
      ])
    })
    expect(result.indicators.urls).toContain('https://evil.example.com/beacon')
    expect(result.indicators.domains).toContain('evil.example.com')
  })

  it('carries phase/source/stack onto findings', () => {
    const result = run({
      recurse: false,
      dump: {
        status: 'dumped',
        schemaVersion: 1,
        phase: 'pre-document',
        entries: [
          { t: 1, kind: 'eval', code: 'x()', stack: 'at a (b.js:1)', sourceUrl: 'https://t.test/' }
        ]
      }
    })
    expect(result.findings[0].phase).toBe('pre-document')
    expect(result.findings[0].stack).toBe('at a (b.js:1)')
    expect(result.findings[0].sourceUrl).toBe('https://t.test/')
  })

  it('reports an empty trace as an error', () => {
    const result = run({ dump: dump([]) })
    expect(result.status).toBe('error')
    expect(result.recordCount).toBe(0)
    expect(result.notes.join(' ')).toContain('no records')
  })

  it('caps analysis at maxRecords and reports partial', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      t: i,
      kind: 'eval',
      code: `f${i}()`
    }))
    const result = run({ dump: dump(entries), maxRecords: 2, recurse: false })
    expect(result.findings).toHaveLength(2)
    expect(result.status).toBe('partial')
    expect(result.notes.join(' ')).toContain('maxRecords')
  })

  it('accepts a pre-normalized trace object directly', () => {
    const trace: DynamicTrace = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      records: [{ t: 1, kind: 'atob', input: 'aGk=', result: 'hi' }]
    }
    const result = run({ trace })
    expect(result.findings[0].payload).toBe('hi')
  })

  it('filters by kind and by class', () => {
    const d = dump([
      { t: 1, kind: 'eval', code: 'a()' },
      { t: 2, kind: 'atob', input: 'aGk=', result: 'hi' }
    ])
    const byKind = run({ recurse: false, dump: d, kinds: ['atob'] })
    expect(byKind.findings).toHaveLength(1)
    expect(byKind.findings[0].kind).toBe('atob')
    expect(byKind.notes.join(' ')).toContain('filtered to kinds')

    const byClass = run({ recurse: false, dump: d, classes: ['eval'] })
    expect(byClass.findings).toHaveLength(1)
    expect(byClass.findings[0].class).toBe('eval')
  })

  it('skips payloads below minLength', () => {
    const result = run({
      recurse: false,
      dump: dump([{ t: 1, kind: 'atob', input: 'x', result: 'hi' }]),
      minLength: 5
    })
    expect(result.findings).toHaveLength(0)
    expect(result.notes.join(' ')).toContain('minimum payload length')
  })

  it('chains static passes up to maxDepth and reports depth', () => {
    const d = dump([{ t: 1, kind: 'eval', code: "var a = atob('aGVsbG8=');" }])
    const one = run({ dump: d, maxDepth: 1 })
    expect(one.findings[0].static?.depth).toBe(1)
    expect(one.findings[0].static?.transformed).toContain('"hello"')

    const more = run({ dump: d, maxDepth: 3 })
    expect(more.findings[0].static?.depth).toBeGreaterThanOrEqual(1)
    expect(more.findings[0].static?.transformed).toContain('"hello"')
  })
})
