import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, ApprovalDecision } from '../../../shared/agent'
import type { NodeContext } from '../../../shared/devtools'
import { reduceTranscript, type TranscriptItem } from './transcript'

/** A DOM node being dragged out of DevTools. */
export type NodeRef = { nodeId: number; label: string; selector: string }

export type ContextAttachment = NodeRef & NodeContext & { id: number }

export type Copilot = {
  messages: TranscriptItem[]
  attachments: ContextAttachment[]
  attach: (node: NodeRef) => Promise<void>
  detach: (id: number) => void
  send: (text: string) => void
  respondApproval: (decision: ApprovalDecision) => void
}

export function useCopilot(): Copilot {
  // Transcript is built from the `agent:event` stream (arch.md §6.1), not from any
  // seeded mock messages. We keep the raw event log and derive ordered items from it.
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const nextId = useRef(1)

  useEffect(() => {
    const unsubscribe = window.reconix.agent.onEvent((event) => {
      setEvents((current) => [...current, event])
    })
    return unsubscribe
  }, [])

  const messages = useMemo(() => reduceTranscript(events), [events])

  const attach = useCallback(async (node: NodeRef) => {
    const context = await window.reconix.devtools.getNodeContext(node.nodeId)
    if (!context) return
    setAttachments((current) =>
      current.some((a) => a.selector === node.selector)
        ? current
        : [...current, { ...node, ...context, id: nextId.current++ }]
    )
  }, [])

  const detach = useCallback((id: number) => {
    setAttachments((current) => current.filter((a) => a.id !== id))
  }, [])

  // §6.1 sendMessage {text}. The user message is echoed back by main as a
  // `user-message` event, so we don't optimistically push into the transcript here.
  const send = useCallback((text: string) => {
    void window.reconix.agent.sendMessage({ text })
    setAttachments([])
  }, [])

  // §6.1 respondApproval — the inline approve / deny / edit controls resolve here.
  const respondApproval = useCallback((decision: ApprovalDecision) => {
    void window.reconix.agent.respondApproval(decision)
  }, [])

  return { messages, attachments, attach, detach, send, respondApproval }
}
