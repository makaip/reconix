import type { AgentEvent, RiskTier } from '../../../shared/agent'

// Pure reducer: folds the `agent:event` stream (arch.md §6.1) into an ordered list of
// renderable transcript items. All content here is agent-/target-derived and is only
// ever rendered as text nodes downstream (arch.md §5.A) — this module never touches
// markup, it just reshapes plain data.

export type TranscriptToolResult = {
  ok: boolean
  summary: string
}

export type TranscriptItem =
  | { kind: 'user-message'; id: string; seq: number; text: string; context: string[] }
  | { kind: 'reasoning'; id: string; seq: number; text: string }
  | {
      kind: 'tool-call'
      id: string
      seq: number
      callId: string
      tool: string
      riskTier: RiskTier
      args: Record<string, string>
      /** Populated when the matching tool-result event arrives. */
      result?: TranscriptToolResult
    }
  | {
      kind: 'approval-request'
      id: string
      seq: number
      approvalId: string
      tool: string
      riskTier: RiskTier
      action: string
      diffPreview: string
      status: 'pending' | 'approved' | 'denied'
    }

/**
 * Builds the ordered transcript from a (possibly unordered) event list.
 *
 * - Items keep the position of the event that first introduced them (by `seq`).
 * - `tool-result` events attach onto their originating `tool-call` item (same `callId`);
 *   an orphan result still renders as its own tool-call stub so nothing is lost.
 * - `approval-request` events dedupe by `approvalId` — a re-emitted event (the human's
 *   decision) updates the existing item's `status` in place rather than appending.
 */
export function reduceTranscript(events: AgentEvent[]): TranscriptItem[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const items: TranscriptItem[] = []
  const callIndex = new Map<string, number>()
  const approvalIndex = new Map<string, number>()

  for (const event of ordered) {
    switch (event.kind) {
      case 'user-message':
        items.push({
          kind: 'user-message',
          id: event.id,
          seq: event.seq,
          text: event.text,
          context: event.context
        })
        break
      case 'reasoning':
        items.push({ kind: 'reasoning', id: event.id, seq: event.seq, text: event.text })
        break
      case 'tool-call': {
        callIndex.set(event.callId, items.length)
        items.push({
          kind: 'tool-call',
          id: event.id,
          seq: event.seq,
          callId: event.callId,
          tool: event.tool,
          riskTier: event.riskTier,
          args: event.args
        })
        break
      }
      case 'tool-result': {
        const at = callIndex.get(event.callId)
        const existing = at !== undefined ? items[at] : undefined
        if (existing && existing.kind === 'tool-call') {
          existing.result = { ok: event.ok, summary: event.summary }
        } else {
          // Orphan result (no preceding call in this batch) — render a stub so the
          // result text is never dropped.
          callIndex.set(event.callId, items.length)
          items.push({
            kind: 'tool-call',
            id: event.id,
            seq: event.seq,
            callId: event.callId,
            tool: event.tool,
            riskTier: 'read-only',
            args: {},
            result: { ok: event.ok, summary: event.summary }
          })
        }
        break
      }
      case 'approval-request': {
        const at = approvalIndex.get(event.approvalId)
        const existing = at !== undefined ? items[at] : undefined
        if (existing && existing.kind === 'approval-request') {
          existing.status = event.status
          existing.diffPreview = event.diffPreview
        } else {
          approvalIndex.set(event.approvalId, items.length)
          items.push({
            kind: 'approval-request',
            id: event.id,
            seq: event.seq,
            approvalId: event.approvalId,
            tool: event.tool,
            riskTier: event.riskTier,
            action: event.action,
            diffPreview: event.diffPreview,
            status: event.status
          })
        }
        break
      }
    }
  }

  return items
}
