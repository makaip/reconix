import { describe, expect, it } from 'vitest'
import {
  clampString,
  capArray,
  clampToolResult,
  MAX_TOOL_RESULT_CHARS,
  MAX_FIELD_CHARS
} from './limits'

describe('clampString', () => {
  it('leaves short strings untouched', () => {
    expect(clampString('short')).toBe('short')
  })
  it('truncates long strings with a count marker', () => {
    const out = clampString('x'.repeat(MAX_FIELD_CHARS + 50))
    expect(out.length).toBeLessThan(MAX_FIELD_CHARS + 50)
    expect(out).toContain('+50 chars')
  })
})

describe('capArray', () => {
  it('returns everything when under the cap', () => {
    expect(capArray([1, 2, 3], 10)).toEqual({ items: [1, 2, 3], omitted: 0 })
  })
  it('caps and reports the remainder', () => {
    expect(capArray([1, 2, 3, 4, 5], 2)).toEqual({ items: [1, 2], omitted: 3 })
  })
})

describe('clampToolResult', () => {
  it('passes small payloads through unchanged', () => {
    const json = JSON.stringify({ ok: true })
    expect(clampToolResult(json)).toBe(json)
  })
  it('truncates an oversized payload and flags it clearly', () => {
    const huge = JSON.stringify({ blob: 'y'.repeat(MAX_TOOL_RESULT_CHARS * 2) })
    const out = clampToolResult(huge)
    expect(out.length).toBeLessThan(huge.length)
    expect(out).toContain('output truncated')
  })
})
