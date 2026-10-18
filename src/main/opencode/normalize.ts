// Maps OpenCode's real SSE events to the normalized AgentEvent union the
// renderer consumes. Confirmed live against `opencode serve` (v2 API,
// 2026-10-17) by subscribing to /api/event and triggering each scenario
// (text reply, tool call incl. a failing one, a permission ask/reply) —
// not a guess at the beta surface. Two naming quirks worth remembering:
//   - Most events are namespaced "session.<resource>.<verb>", but
//     permissions are the odd one out: top-level "permission.asked" /
//     "permission.replied", no "session." prefix.
//   - A frame's payload lives under `.data`, e.g.
//     { type: "session.text.delta", data: { assistantMessageID, delta } }.
// Unknown events return null (dropped from the transcript but still
// available to the audit persister if needed).

import type { AgentEvent, RiskTier } from '../../shared/contracts'
import type { RawEvent } from './transport'

function s(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function data(raw: RawEvent): Record<string, unknown> {
  return (raw.data ?? {}) as Record<string, unknown>
}

// OpenCode's tool-call lifecycle is split across events that don't each
// carry everything we need: "session.tool.input.started" has the tool
// *name* but not its input; "session.tool.called" has the resolved input
// but not the name. We stitch them together by call id so a single
// tool.call AgentEvent still carries both. Call ids ("call_…") are globally
// unique, so this is safe without being session-scoped.
const pendingToolNames = new Map<string, string>()

export function normalize(raw: RawEvent): AgentEvent | null {
  const d = data(raw)

  switch (raw.type) {
    case 'session.tool.input.started': {
      const callId = s(d.id)
      if (callId) pendingToolNames.set(callId, s(d.name, 'unknown'))
      return null // no AgentEvent yet — wait for session.tool.called
    }

    case 'session.tool.called': {
      const callId = s(d.id)
      const tool = s(d.name, pendingToolNames.get(callId) ?? 'unknown')
      return {
        kind: 'tool.call',
        callId,
        tool,
        params: d.input ?? {},
        riskTier: 'R' as RiskTier, // OpenCode's built-in tools carry no tier; Reconix's own MCP tools will, once registered.
        target: undefined
      }
    }

    case 'session.tool.success': {
      const callId = s(d.id)
      pendingToolNames.delete(callId)
      const metadata = (d.metadata ?? {}) as Record<string, unknown>
      // Shell-type tools report a process exit code inside metadata even on
      // a "success" event (the *mechanism* succeeded; the command may not
      // have). Surface a nonzero exit as a failed tool.result.
      const exit = typeof metadata.exit === 'number' ? metadata.exit : undefined
      if (exit !== undefined && exit !== 0) {
        return { kind: 'tool.result', callId, ok: false, error: `exited with code ${exit}` }
      }
      return { kind: 'tool.result', callId, ok: true }
    }

    // Not yet observed live (never hit a genuine tool-level exception while
    // probing), but every other resource in this API follows a
    // success/error pair, so this is the predicted counterpart to
    // session.tool.success rather than a blind guess.
    case 'session.tool.error':
    case 'session.tool.failed': {
      const callId = s(d.id)
      pendingToolNames.delete(callId)
      return { kind: 'tool.result', callId, ok: false, error: s(d.error ?? d.message, 'tool error') }
    }

    case 'session.text.delta':
      return {
        kind: 'message.delta',
        messageId: s(d.assistantMessageID),
        role: 'assistant',
        text: s(d.delta)
      }

    case 'session.reasoning.delta':
      return { kind: 'reasoning.delta', messageId: s(d.assistantMessageID), text: s(d.delta) }

    // "permission.*" — confirmed to NOT be namespaced under "session.".
    case 'permission.asked':
      return {
        kind: 'approval.request',
        approvalId: s(d.id),
        callId: '', // OpenCode's permission model keys off (action, resources), not a tool callId.
        tool: s(d.action),
        params: { resources: d.resources ?? [] },
        riskTier: 'M',
        target: Array.isArray(d.resources) && typeof d.resources[0] === 'string' ? d.resources[0] : undefined
      }

    case 'permission.replied': {
      const reply = s(d.reply, 'reject')
      const decision = reply === 'reject' ? 'deny' : 'approve' // "once"/"always" both read back as approve.
      return { kind: 'approval.resolved', approvalId: s(d.requestID), decision }
    }

    // Marks the whole turn done, not just one step — fires after any tool
    // loop settles. No assistantMessageID on this particular payload, so we
    // key turn.done off the session id; one session is one conversation
    // thread in our model, so the renderer can still resolve which turn ended.
    case 'session.execution.succeeded':
      return { kind: 'turn.done', messageId: s(d.sessionID) }

    case 'session.execution.interrupted':
      return { kind: 'turn.done', messageId: s(d.sessionID) }

    // Shape inferred (mirrors .succeeded's sessionID-only payload); not
    // triggered live — a failing shell command surfaces as a tool.result,
    // not an execution-level failure, and nothing else reliably forced one.
    case 'session.execution.failed':
      return { kind: 'error', scope: 'session', message: s(d.message ?? d.error, 'session execution failed') }

    default:
      return null
  }
}
