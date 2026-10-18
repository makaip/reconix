import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { deobfuscateStaticTool } from './deobfuscateStatic'

const tool = deobfuscateStaticTool

function run(source: string, extra: Record<string, unknown> = {}) {
  return invokeTool(tool, { source, ...extra })
}

describe('deobfuscate_static', () => {
  it('constant-folds literal expressions', () => {
    const result = run('var total = 1 + 2 * 3;')
    expect(result.transformed).toContain('total = 7')
    expect(result.passes.find((p) => p.name === 'constant-fold')?.changed).toBe(true)
  })

  it('resolves decoder chains (atob)', () => {
    const result = run("var a = atob('aGVsbG8=');")
    expect(result.transformed).toContain('"hello"')
  })

  it('unpacks an obfuscator.io-style string array + decoder', () => {
    const source = [
      "var _0x4a2b = ['bG9n', 'YWRtaW4=', 'Zm9v', 'YmFy', 'YmF6'];",
      'function _0x1f3e(_0xi) { return atob(_0x4a2b[_0xi]); }',
      'console.log(_0x1f3e(0), _0x1f3e(1));'
    ].join('\n')
    const result = run(source)
    expect(result.transformed).toContain('"log"')
    expect(result.transformed).toContain('"admin"')
    // The mangled array/decoder names are demangled away.
    expect(result.transformed).not.toContain('_0x4a2b')
  })

  it('fails closed when a string array is touched by unmodelled code', () => {
    const source = [
      "var a = ['x', 'y', 'z', 'w', 'q'];",
      'window.register(a);',
      'function d(i) { return a[i]; }',
      'd(0);'
    ].join('\n')
    const result = run(source)
    expect(result.passes.find((p) => p.name === 'string-array-unpack')?.changed).toBe(false)
    expect(result.notes.some((n) => n.includes('skipped'))).toBe(true)
  })

  it('unpacks a Dean Edwards packer payload', () => {
    const original = '$(document).ready(function(){console.log("hi")});'
    const tokens = ['$(document).ready', 'function', 'console', 'log']
    let packed = original
    for (let i = tokens.length - 1; i >= 0; i--) {
      packed = packed.split(tokens[i]).join(String(i))
    }
    const script =
      'eval(function(p,a,c,k,e,r){return p}(' +
      `${JSON.stringify(packed)},62,${tokens.length},` +
      `${JSON.stringify(tokens.join('|'))}.split('|'),0,{}))`
    const result = run(script)
    expect(result.family.name).toBe('dean-edwards-packer')
    expect(result.metrics.evalCount).toBe(1)
    expect(result.transformed).not.toContain('eval(')
    expect(result.transformed).toContain('console')
    expect(result.transformed).toContain('document')
  })

  it('demangles _0x identifiers declared once', () => {
    const result = run('var _0xabc = 1; var _0xdef = 2; console.log(_0xabc + _0xdef);')
    expect(result.transformed).toMatch(/\bv\d+\b/)
    expect(result.transformed).not.toContain('_0xabc')
  })

  it('removes unreferenced local declarations but keeps globals', () => {
    const result = run(
      'function outer() { function unused() { return 1; } function used() { return 2; } return used(); } outer();'
    )
    expect(result.transformed).not.toContain('unused')
    expect(result.transformed).toContain('used')
    // `outer` is a top-level function (a global) and must survive.
    expect(result.transformed).toContain('outer')
  })

  it('extracts URL/domain indicators', () => {
    const result = run('var u = "http://example.com/path";')
    expect(result.indicators.urls).toContain('http://example.com/path')
    expect(result.indicators.domains).toContain('example.com')
  })

  it('reports a structural family and metrics', () => {
    const result = run('var _0xabc = 1;\nfunction _0xdef() { return _0xabc; }\n_0xdef();')
    expect(result.metrics.identifierManglingRatio).toBeGreaterThan(0)
    expect(result.family.confidence).toBeGreaterThan(0)
    expect(result.status).toBe('ok')
  })

  it('truncates output past maxOutputBytes and marks the result partial', () => {
    const result = run('var x = 1 + 2 * 3; var y = "a fairly long string literal here";', {
      maxOutputBytes: 10
    })
    expect(result.truncated).toBe(true)
    expect(result.status).toBe('partial')
  })

  it('honours the technique allowlist', () => {
    const result = run('var x = 1 + 2 * 3;', { techniques: ['rename'] })
    expect(result.passes.map((p) => p.name)).toEqual(['rename'])
    expect(result.transformed).toContain('1 + 2 * 3')
  })

  it('rejects hostile input: wrong type', () => {
    expect(() => invokeTool(tool, { source: 42 })).toThrow(ToolInputError)
  })

  it('rejects hostile input: missing source', () => {
    expect(() => invokeTool(tool, {})).toThrow(ToolInputError)
  })

  it('rejects hostile input: empty source', () => {
    expect(() => invokeTool(tool, { source: '' })).toThrow(ToolInputError)
  })

  it('rejects hostile input: unknown technique', () => {
    expect(() => invokeTool(tool, { source: 'var a=1;', techniques: ['nope'] })).toThrow(
      ToolInputError
    )
  })

  it('reports a parse failure as an error without throwing', () => {
    const result = run('function (}{ this is not javascript')
    expect(result.status).toBe('error')
    expect(result.transformed).toBe('')
    expect(result.notes.some((n) => n.includes('parse failed'))).toBe(true)
  })
})
