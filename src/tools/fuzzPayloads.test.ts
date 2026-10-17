import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { genFuzzPayloadsTool } from './fuzzPayloads'

describe('gen_fuzz_payloads', () => {
  const validInput = {
    corpus: ['xss', 'sqli'],
    encodings: ['url', 'base64'],
    boundaries: ['empty', 'null-byte']
  }

  it('happy path: returns payload strings covering requested corpora/encodings/boundaries', () => {
    const result = invokeTool(genFuzzPayloadsTool, validInput)
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((p) => typeof p === 'string')).toBe(true)
    expect(result).toContain('<script>alert(1)</script>')
    expect(result).toContain('')
  })

  it('is deterministic given the same input', () => {
    const r1 = invokeTool(genFuzzPayloadsTool, validInput)
    const r2 = invokeTool(genFuzzPayloadsTool, validInput)
    expect(r1).toEqual(r2)
  })

  it('rejects malformed/hostile input: wrong type', () => {
    expect(() => invokeTool(genFuzzPayloadsTool, 'not an object')).toThrow(ToolInputError)
  })

  it('rejects hostile input: unknown corpus value', () => {
    expect(() =>
      invokeTool(genFuzzPayloadsTool, {
        corpus: ['rce-rm-rf'],
        encodings: [],
        boundaries: []
      })
    ).toThrow(ToolInputError)
  })

  it('rejects hostile input: null and arrays-as-top-level', () => {
    expect(() => invokeTool(genFuzzPayloadsTool, null)).toThrow(ToolInputError)
    expect(() => invokeTool(genFuzzPayloadsTool, [])).toThrow(ToolInputError)
  })

  it('rejects hostile input: non-array fields', () => {
    expect(() =>
      invokeTool(genFuzzPayloadsTool, { corpus: 'xss', encodings: [], boundaries: [] })
    ).toThrow(ToolInputError)
  })
})
