import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { detectEncodingTool } from './detectEncoding'

describe('detect_encoding', () => {
  it('happy path: plain text is low entropy, no special encoding', () => {
    const result = invokeTool(detectEncodingTool, {
      body: 'the quick brown fox jumps over the lazy dog repeatedly'
    })
    expect(result.likelyEncodings).toContain('plain-text')
    expect(result.highEntropy).toBe(false)
  })

  it('happy path: detects base64-shaped body', () => {
    const b64 = Buffer.from('hello world, this is a test payload').toString('base64')
    const result = invokeTool(detectEncodingTool, { body: b64 })
    expect(result.likelyEncodings).toContain('base64')
  })

  it('happy path: detects url-encoded body', () => {
    const result = invokeTool(detectEncodingTool, { body: 'foo%20bar%3Dbaz%26x%3D1' })
    expect(result.likelyEncodings).toContain('url-encoded')
  })

  it('happy path: high-entropy random-ish body flagged', () => {
    const random = Array.from({ length: 200 }, (_, i) =>
      String.fromCharCode(33 + ((i * 37) % 90))
    ).join('')
    const result = invokeTool(detectEncodingTool, { body: random })
    expect(result.entropy).toBeGreaterThan(4.5)
    expect(result.highEntropy).toBe(true)
    expect(result.flags.some((f) => f.includes('high-entropy'))).toBe(true)
  })

  it('rejects malformed/hostile input: wrong type', () => {
    expect(() => invokeTool(detectEncodingTool, { body: 42 })).toThrow(ToolInputError)
  })

  it('rejects hostile input: missing body', () => {
    expect(() => invokeTool(detectEncodingTool, {})).toThrow(ToolInputError)
  })

  it('rejects hostile input: oversized body', () => {
    expect(() => invokeTool(detectEncodingTool, { body: 'a'.repeat(5_000_001) })).toThrow(
      ToolInputError
    )
  })
})
