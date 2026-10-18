import { describe, expect, it, vi } from 'vitest'
import { submitForm } from './submitForm'
import { buildMcpServer } from '../index'
import type { ToolContext } from '../tool'
import type { AuditLogger } from '../audit'

const target = { action: 'https://example.test/submit', method: 'post' }
function context() {
  const evaluate = vi.fn().mockResolvedValueOnce(JSON.stringify(target)).mockResolvedValueOnce(JSON.stringify({ ok: true, status: 'submission_requested', ...target }))
  const assertInScope = vi.fn()
  return { evaluate, assertInScope, ctx: { cdp: { evaluate }, scope: { assertInScope } } as unknown as ToolContext }
}

describe('submit_form', () => {
  it('checks the effective form destination before requesting submission', async () => {
    const { ctx, assertInScope, evaluate } = context()
    await expect(submitForm.execute(submitForm.parse({ selector: '#form', submitterSelector: '#send' }), ctx)).resolves.toMatchObject({ status: 'submission_requested' })
    expect(assertInScope).toHaveBeenCalledWith(target.action)
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(assertInScope.mock.invocationCallOrder[0]).toBeLessThan(evaluate.mock.invocationCallOrder[1])
  })

  it('never submits to an out-of-scope action', async () => {
    const { ctx, assertInScope, evaluate } = context()
    assertInScope.mockImplementation(() => { throw new Error('out of scope') })
    await expect(submitForm.execute(submitForm.parse({ selector: '#form' }), ctx)).rejects.toThrow('out of scope')
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('surfaces validation errors without claiming successful submission', async () => {
    const { ctx, evaluate } = context()
    evaluate.mockReset().mockResolvedValueOnce(JSON.stringify(target)).mockResolvedValueOnce(JSON.stringify({ error: 'Form validation failed: email' }))
    await expect(submitForm.execute(submitForm.parse({ selector: '#form' }), ctx)).rejects.toThrow('validation failed')
  })

  it.each([{}, { selector: '' }, { selector: 'form', submitterSelector: '' }, { selector: 'form', submitterSelector: 3 }])('rejects malformed inputs %#', (raw) => {
    expect(() => submitForm.parse(raw)).toThrow()
  })

  it('replaces the stub on both tool surfaces with a mutating tool', () => {
    for (const surface of ['all', 'mvp'] as const) {
      const server = buildMcpServer({ surface, context: {} as ToolContext, audit: {} as AuditLogger })
      const matches = server.listTools().filter((t) => t.name === 'submit_form')
      expect(matches).toHaveLength(1)
      expect(matches[0].riskTier).toBe('M')
      expect(matches[0].inputSchema.required).toEqual(['selector'])
    }
  })
})
