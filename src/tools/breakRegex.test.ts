import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { breakRegexTool } from './breakRegex'

describe('break_regex', () => {
  it('happy path: benign pattern reports not vulnerable', () => {
    const result = invokeTool(breakRegexTool, { pattern: '^[a-z0-9_-]{3,16}$' })
    expect(result.vulnerable).toBe(false)
    expect(result.redosCandidates).toEqual([])
  })

  it('flags a known catastrophic pattern (a+)+$ and returns candidates without hanging', () => {
    const start = Date.now()
    const result = invokeTool(breakRegexTool, { pattern: '(a+)+$' })
    const elapsedMs = Date.now() - start

    expect(result.vulnerable).toBe(true)
    expect(result.redosCandidates.length).toBeGreaterThan(0)
    expect(result.redosCandidates[0].candidate.length).toBeGreaterThan(0)
    expect(result.redosCandidates[0].matchedStructure).toContain('(a+)+')
    // Static analysis only: must return near-instantly regardless of pattern shape.
    expect(elapsedMs).toBeLessThan(500)
  })

  it('flags overlapping alternation inside a quantified group', () => {
    const result = invokeTool(breakRegexTool, { pattern: '(a|a)+b' })
    expect(result.vulnerable).toBe(true)
    expect(result.redosCandidates.some((c) => c.reason.includes('alternation'))).toBe(true)
  })

  it('rejects malformed/hostile input: wrong type', () => {
    expect(() => invokeTool(breakRegexTool, { pattern: 123 })).toThrow(ToolInputError)
  })

  it('rejects hostile input: empty pattern', () => {
    expect(() => invokeTool(breakRegexTool, { pattern: '' })).toThrow(ToolInputError)
  })

  it('rejects hostile input: oversized pattern', () => {
    expect(() => invokeTool(breakRegexTool, { pattern: 'a'.repeat(3000) })).toThrow(
      ToolInputError
    )
  })

  it('never executes the pattern as a RegExp against generated candidates', () => {
    // A pattern that WOULD hang if run via `new RegExp(pattern).test(candidate)`.
    // We only assert the tool returns quickly; it must not construct/execute it.
    const start = Date.now()
    const result = invokeTool(breakRegexTool, { pattern: '(a+)+(b+)+$' })
    expect(Date.now() - start).toBeLessThan(500)
    expect(result.vulnerable).toBe(true)
  })
})
