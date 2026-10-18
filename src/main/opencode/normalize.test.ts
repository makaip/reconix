import { describe, expect, it } from 'vitest'
import { normalize } from './normalize'

describe('OpenCode event normalization', () => {
  it('uses a self-contained tool name when the called event provides one', () => {
    expect(
      normalize({
        type: 'session.tool.called',
        data: { id: 'call-1', name: 'navigate', input: { url: 'https://example.test' } }
      })
    ).toEqual({
      kind: 'tool.call',
      callId: 'call-1',
      tool: 'navigate',
      params: { url: 'https://example.test' },
      riskTier: 'R',
      target: undefined
    })
  })

  it('surfaces the current V2 failed event as a failed tool result', () => {
    expect(
      normalize({ type: 'session.tool.failed', data: { id: 'call-2', error: 'navigation failed' } })
    ).toEqual({ kind: 'tool.result', callId: 'call-2', ok: false, error: 'navigation failed' })
  })
})
