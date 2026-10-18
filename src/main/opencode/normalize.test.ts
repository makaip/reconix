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

  describe('session.execution.failed surfaces the real cause', () => {
    it('keeps a top-level string message', () => {
      expect(
        normalize({ type: 'session.execution.failed', data: { message: 'context length exceeded' } })
      ).toEqual({ kind: 'error', scope: 'session', message: 'context length exceeded' })
    })

    it('digs the message out of a nested error object', () => {
      expect(
        normalize({
          type: 'session.execution.failed',
          data: { error: { name: 'AI_APICallError', message: 'connection refused' } }
        })
      ).toEqual({ kind: 'error', scope: 'session', message: 'connection refused' })
    })

    it('reaches into error.data for provider bodies', () => {
      expect(
        normalize({
          type: 'session.execution.failed',
          data: { error: { name: 'APICallError', data: { message: 'invalid api key (401)' } } }
        })
      ).toEqual({ kind: 'error', scope: 'session', message: 'invalid api key (401)' })
    })

    it('falls back to the error name, then the generic string, when no message exists', () => {
      expect(
        normalize({ type: 'session.execution.failed', data: { error: { name: 'TimeoutError' } } })
      ).toEqual({ kind: 'error', scope: 'session', message: 'TimeoutError' })
      expect(normalize({ type: 'session.execution.failed', data: {} })).toEqual({
        kind: 'error',
        scope: 'session',
        message: 'session execution failed'
      })
    })
  })

  it('flattens tool content parts into the result output', () => {
    expect(
      normalize({
        type: 'session.tool.success',
        data: {
          id: 'call-3',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
            { type: 'file', name: 'shot.png', mime: 'image/png' }
          ]
        }
      })
    ).toEqual({ kind: 'tool.result', callId: 'call-3', ok: true, output: 'line one\nline two\n[file] shot.png' })
  })

  it('falls back to metadata.output when the result has no content parts', () => {
    expect(
      normalize({ type: 'session.tool.success', data: { id: 'call-4', metadata: { exit: 0, output: 'stdout text' } } })
    ).toEqual({ kind: 'tool.result', callId: 'call-4', ok: true, output: 'stdout text' })
  })

  it('still reports a nonzero exit as a failure, keeping the output', () => {
    expect(
      normalize({ type: 'session.tool.success', data: { id: 'call-5', metadata: { exit: 2, output: 'boom' } } })
    ).toEqual({ kind: 'tool.result', callId: 'call-5', ok: false, error: 'exited with code 2', output: 'boom' })
  })
})
