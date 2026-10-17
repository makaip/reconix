import { describe, expect, it } from 'vitest'
import { invokeTool, ToolInputError } from '../shared/tools'
import { mineParamsTool } from './mineParams'

describe('mine_params', () => {
  it('default (empty input) returns a non-empty, sorted, capped candidate set', () => {
    const result = invokeTool(mineParamsTool, {})
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.count).toBe(result.candidates.length)
    expect(result.candidates.length).toBeLessThanOrEqual(5000)
    // sorted ascending
    const sorted = [...result.candidates].sort()
    expect(result.candidates).toEqual(sorted)
    // all six built-in buckets present by default
    for (const cat of ['common', 'idor', 'debug', 'auth', 'pagination', 'redirect']) {
      expect(result.byCategory[cat]?.length).toBeGreaterThan(0)
    }
    // flat list is de-duped
    expect(new Set(result.candidates).size).toBe(result.candidates.length)
  })

  it('category filter narrows output', () => {
    const all = invokeTool(mineParamsTool, {})
    const common = invokeTool(mineParamsTool, { categories: ['common'] })
    expect(common.candidates.length).toBeLessThan(all.candidates.length)
    expect(Object.keys(common.byCategory)).toEqual(['common'])
    expect(common.candidates).toContain('id')
    expect(common.candidates).not.toContain('token') // auth bucket excluded
  })

  it('observed names produce sibling/variant guesses (userId -> user_id, uid, account_id)', () => {
    const result = invokeTool(mineParamsTool, { observed: ['userId'] })
    expect(result.byCategory.observed).toBeDefined()
    expect(result.candidates).toContain('user_id')
    expect(result.candidates).toContain('uid')
    expect(result.candidates).toContain('account_id')
    expect(result.candidates).toContain('UserId')
  })

  it('de-dupes names shared across buckets and observed', () => {
    // 'page' lives in both common and pagination; observing it must not duplicate.
    const result = invokeTool(mineParamsTool, {
      categories: ['common', 'pagination'],
      observed: ['page']
    })
    const pageCount = result.candidates.filter((c) => c === 'page').length
    expect(pageCount).toBe(1)
    // but it is attributed to each category it came from
    expect(result.byCategory.common).toContain('page')
    expect(result.byCategory.pagination).toContain('page')
  })

  it('includeCaseVariants adds snake/camel/Pascal forms to bucket names', () => {
    const without = invokeTool(mineParamsTool, { categories: ['idor'] })
    const withVariants = invokeTool(mineParamsTool, {
      categories: ['idor'],
      includeCaseVariants: true
    })
    // 'user_id' is the bucket seed; camel form only appears with the flag.
    expect(without.candidates).toContain('user_id')
    expect(without.candidates).not.toContain('userId')
    expect(withVariants.candidates).toContain('userId')
    expect(withVariants.candidates).toContain('UserId')
    expect(withVariants.candidates.length).toBeGreaterThan(without.candidates.length)
  })

  it('rejects hostile input: not an object', () => {
    expect(() => invokeTool(mineParamsTool, 'nope')).toThrow(ToolInputError)
    expect(() => invokeTool(mineParamsTool, [])).toThrow(ToolInputError)
    expect(() => invokeTool(mineParamsTool, null)).toThrow(ToolInputError)
  })

  it('rejects hostile input: observed not a string[]', () => {
    expect(() => invokeTool(mineParamsTool, { observed: [1, 2, 3] })).toThrow(ToolInputError)
    expect(() => invokeTool(mineParamsTool, { observed: 'userId' })).toThrow(ToolInputError)
  })

  it('rejects hostile input: unknown category', () => {
    expect(() => invokeTool(mineParamsTool, { categories: ['bogus'] })).toThrow(ToolInputError)
  })

  it('rejects hostile input: includeCaseVariants wrong type', () => {
    expect(() => invokeTool(mineParamsTool, { includeCaseVariants: 'yes' })).toThrow(
      ToolInputError
    )
  })

  it('rejects hostile input: observed over size bound', () => {
    const huge = Array.from({ length: 501 }, (_, i) => `p${i}`)
    expect(() => invokeTool(mineParamsTool, { observed: huge })).toThrow(ToolInputError)
    expect(() => invokeTool(mineParamsTool, { observed: ['a'.repeat(201)] })).toThrow(
      ToolInputError
    )
  })

  it('output stays within the 5000 candidate cap', () => {
    const result = invokeTool(mineParamsTool, { includeCaseVariants: true })
    expect(result.candidates.length).toBeLessThanOrEqual(5000)
    expect(result.count).toBe(result.candidates.length)
  })
})
