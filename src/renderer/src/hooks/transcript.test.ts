import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '../../../shared/agent'
import { reduceTranscript, type TranscriptItem } from './transcript'

// Minimal event factory — only the fields each kind needs, plus ordering metadata.
// Distributive Omit keeps each variant's discriminant/fields intact.
type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
let seq = 0
const ev = (e: DistOmit<AgentEvent, 'id' | 'seq' | 'ts'>): AgentEvent =>
  ({ ...e, id: `evt-${seq}`, seq: seq++, ts: seq }) as AgentEvent

const findApproval = (items: TranscriptItem[], approvalId: string): TranscriptItem | undefined =>
  items.find((i) => i.kind === 'approval-request' && i.approvalId === approvalId)

describe('reduceTranscript', () => {
  it('orders items by seq regardless of input order', () => {
    const a: AgentEvent = { kind: 'reasoning', id: 'e1', seq: 2, ts: 2, text: 'second' }
    const b: AgentEvent = { kind: 'user-message', id: 'e2', seq: 1, ts: 1, text: 'first', context: [] }
    const items = reduceTranscript([a, b])
    expect(items.map((i) => i.id)).toEqual(['e2', 'e1'])
  })

  it('attaches a tool-result onto its originating tool-call', () => {
    seq = 0
    const events = [
      ev({ kind: 'tool-call', callId: 'c1', tool: 'csrf-token-checker', riskTier: 'read-only', args: { target: '/x' } }),
      ev({ kind: 'tool-result', callId: 'c1', tool: 'csrf-token-checker', ok: true, summary: 'all good' })
    ]
    const items = reduceTranscript(events)
    expect(items).toHaveLength(1)
    const call = items[0]
    expect(call.kind).toBe('tool-call')
    if (call.kind === 'tool-call') {
      expect(call.args).toEqual({ target: '/x' })
      expect(call.result).toEqual({ ok: true, summary: 'all good' })
    }
  })

  it('renders an orphan tool-result as its own stub so nothing is dropped', () => {
    seq = 0
    const items = reduceTranscript([
      ev({ kind: 'tool-result', callId: 'ghost', tool: 't', ok: false, summary: 'orphaned' })
    ])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('tool-call')
    if (items[0].kind === 'tool-call') {
      expect(items[0].result).toEqual({ ok: false, summary: 'orphaned' })
    }
  })

  it('dedupes approval-request by approvalId and updates status in place', () => {
    seq = 0
    const events = [
      ev({
        kind: 'approval-request',
        approvalId: 'ap1',
        tool: 'xss-payload-injector',
        riskTier: 'mutating',
        action: 'Probe XSS',
        diffPreview: 'run probe',
        status: 'pending'
      }),
      ev({ kind: 'reasoning', text: 'working' }),
      ev({
        kind: 'approval-request',
        approvalId: 'ap1',
        tool: 'xss-payload-injector',
        riskTier: 'mutating',
        action: 'Probe XSS',
        diffPreview: 'preview=edited',
        status: 'approved'
      })
    ]
    const items = reduceTranscript(events)
    // Still exactly one approval item, resolved, and kept at its original position.
    const approvals = items.filter((i) => i.kind === 'approval-request')
    expect(approvals).toHaveLength(1)
    const ap = findApproval(items, 'ap1')
    expect(ap?.kind).toBe('approval-request')
    if (ap?.kind === 'approval-request') {
      expect(ap.status).toBe('approved')
      expect(ap.diffPreview).toBe('preview=edited')
    }
    expect(items[0].kind).toBe('approval-request')
  })

  it('preserves agent/target text verbatim (no sanitization/markup handling)', () => {
    seq = 0
    const payload = '"><svg onload=alert(1)>'
    const items = reduceTranscript([
      ev({ kind: 'tool-call', callId: 'c1', tool: 'xss-payload-injector', riskTier: 'mutating', args: { payload } })
    ])
    expect(items[0].kind).toBe('tool-call')
    if (items[0].kind === 'tool-call') {
      // Reducer is pure data — it passes the reflected payload through untouched; the
      // renderer is responsible for text-node-only output (§5.A).
      expect(items[0].args.payload).toBe(payload)
    }
  })
})
