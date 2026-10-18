import { describe, expect, it } from 'vitest'
import { ProgressMonitor } from './progress'

const passage = 'I will now examine the endpoint and review the available evidence before deciding what action to take next. '

describe('ProgressMonitor', () => {
  it('detects prose repetition across token-sized chunks', () => {
    const monitor = new ProgressMonitor()
    const reasons: string[] = []
    for (const text of passage.repeat(5)) {
      const reason = monitor.observe({ kind: 'message.delta', messageId: 'm', role: 'assistant', text })
      if (reason) reasons.push(reason)
    }
    expect(reasons).toHaveLength(1)
  })

  it('checks a finished response even before the next sampling interval', () => {
    const monitor = new ProgressMonitor()
    const block = 'abcdefghij'.repeat(8)
    expect(monitor.observe({ kind: 'message.delta', messageId: 'm', role: 'assistant', text: block.repeat(2) })).toBeUndefined()
    expect(monitor.observe({ kind: 'message.delta', messageId: 'm', role: 'assistant', text: block })).toBeUndefined()
    expect(monitor.observe({ kind: 'turn.done', messageId: 's' })).toContain('Repeated')
  })

  it('detects alternating failures despite argument property order', () => {
    const monitor = new ProgressMonitor()
    const reasons: string[] = []
    for (let i = 0; i < 6; i++) {
      monitor.observe({ kind: 'tool.call', callId: `${i}`, tool: i % 2 ? 'read' : 'probe',
        params: i < 2 ? { a: 1, b: 2 } : { b: 2, a: 1 }, riskTier: 'R' })
      const reason = monitor.observe({ kind: 'tool.result', callId: `${i}`, ok: false, error: 'Unavailable' })
      if (reason) reasons.push(reason)
    }
    expect(reasons).toHaveLength(1)
  })

  it('allows successful polling and changing failures', () => {
    const monitor = new ProgressMonitor()
    for (let i = 0; i < 12; i++) {
      expect(monitor.observe({ kind: 'tool.call', callId: `${i}`, tool: 'poll', params: {}, riskTier: 'R' })).toBeUndefined()
      expect(monitor.observe({ kind: 'tool.result', callId: `${i}`, ok: i < 6,
        output: i < 6 ? 'pending' : `failure ${i}` })).toBeUndefined()
    }
  })

  it('detects failed fills interleaved with successful clicks', () => {
    const monitor = new ProgressMonitor()
    const reasons: string[] = []
    for (let i = 0; i < 3; i++) {
      monitor.observe({ kind: 'tool.call', callId: `fill${i}`, tool: 'reconix_fill', params: { selector: '#upload', value: 'test.txt' }, riskTier: 'P' })
      const reason = monitor.observe({ kind: 'tool.result', callId: `fill${i}`, ok: false, error: 'Cannot set a file input' })
      if (reason) reasons.push(reason)
      monitor.observe({ kind: 'tool.call', callId: `click${i}`, tool: 'reconix_click', params: { selector: '#upload' }, riskTier: 'P' })
      expect(monitor.observe({ kind: 'tool.result', callId: `click${i}`, ok: true })).toBeUndefined()
    }
    expect(reasons).toHaveLength(1)
  })

  it('clears past failures when that exact attempt succeeds', () => {
    const monitor = new ProgressMonitor()
    for (let i = 0; i < 5; i++) {
      monitor.observe({ kind: 'tool.call', callId: `${i}`, tool: 'fill', params: { selector: '#name', value: 'name' }, riskTier: 'P' })
      expect(monitor.observe({ kind: 'tool.result', callId: `${i}`, ok: i === 2, error: i === 2 ? undefined : 'not ready' })).toBeUndefined()
    }
  })
})
