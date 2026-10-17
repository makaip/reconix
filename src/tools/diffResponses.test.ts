import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { diffResponsesTool } from './diffResponses'

describe('diff_responses', () => {
  it('happy path: detects status/length/timing/body differences', () => {
    const result = invokeTool(diffResponsesTool, {
      a: { status: 200, body: 'line1\nline2\nline3', timingMs: 100 },
      b: { status: 500, body: 'line1\nCHANGED\nline3', timingMs: 250 }
    })
    expect(result.statusChanged).toBe(true)
    expect(result.statusA).toBe(200)
    expect(result.statusB).toBe(500)
    expect(result.timingDeltaMs).toBe(150)
    expect(result.bodyIdentical).toBe(false)
    expect(result.changedLineCount).toBeGreaterThan(0)
  })

  it('happy path: identical responses report no changes', () => {
    const resp = { status: 200, body: 'same body' }
    const result = invokeTool(diffResponsesTool, { a: resp, b: { ...resp } })
    expect(result.statusChanged).toBe(false)
    expect(result.bodyIdentical).toBe(true)
    expect(result.lengthDelta).toBe(0)
    expect(result.changedLineCount).toBe(0)
  })

  it('rejects malformed/hostile input: missing fields', () => {
    expect(() => invokeTool(diffResponsesTool, { a: { status: 200 } })).toThrow(ToolInputError)
  })

  it('rejects hostile input: status out of range', () => {
    expect(() =>
      invokeTool(diffResponsesTool, {
        a: { status: 99999, body: 'x' },
        b: { status: 200, body: 'y' }
      })
    ).toThrow(ToolInputError)
  })

  it('rejects hostile input: non-string headers values', () => {
    expect(() =>
      invokeTool(diffResponsesTool, {
        a: { status: 200, body: 'x', headers: { foo: 123 } },
        b: { status: 200, body: 'y' }
      })
    ).toThrow(ToolInputError)
  })
})
