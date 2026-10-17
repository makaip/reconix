import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeContext } from '../../../shared/devtools'
import type { AgentEvent } from '../../../shared/contracts'
import type { CopilotMessage } from '../mock/data'

/** A DOM node being dragged out of DevTools. */
export type NodeRef = { nodeId: number; label: string; selector: string }

export type ContextAttachment = NodeRef & NodeContext & { id: number }

export type Copilot = {
  messages: CopilotMessage[]
  attachments: ContextAttachment[]
  attach: (node: NodeRef) => Promise<void>
  detach: (id: number) => void
  send: (text: string) => void
}

export function useCopilot(): Copilot {
  const [messages, setMessages] = useState<CopilotMessage[]>([])
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const nextId = useRef(1)

  // Tracks which assistant CopilotMessage.id owns a given OpenCode
  // messageId, so repeated message.delta events accumulate into one bubble
  // instead of appending a new one per chunk.
  const assistantByMessageId = useRef(new Map<string, string>())

  useEffect(() => {
    const unsubscribe = window.reconix.copilot.onEvent((ev: AgentEvent) => {
      switch (ev.kind) {
        case 'message.delta': {
          const existingId = assistantByMessageId.current.get(ev.messageId)
          setMessages((current) => {
            if (existingId) {
              return current.map((m) =>
                m.id === existingId && m.role === 'assistant' ? { ...m, text: m.text + ev.text } : m
              )
            }
            const id = `asst-${nextId.current++}`
            assistantByMessageId.current.set(ev.messageId, id)
            return [...current, { id, role: 'assistant', used: 'OpenCode', text: ev.text }]
          })
          return
        }
        case 'error': {
          const id = `asst-${nextId.current++}`
          setMessages((current) => [
            ...current,
            { id, role: 'assistant', used: 'OpenCode', text: `⚠ ${ev.message}` }
          ])
          return
        }
        case 'turn.done':
          assistantByMessageId.current.delete(ev.messageId)
          return
        default:
          // tool.call / tool.result / reasoning.delta / approval.* have no
          // transcript rendering yet (Message.tsx only knows user/assistant
          // text bubbles) — dropped here, not lost: persist() in main still
          // writes every raw event through for the audit trail.
          return
      }
    })
    return unsubscribe
  }, [])

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

  const send = useCallback(
    (text: string) => {
      setMessages((current) => [
        ...current,
        {
          id: `user-${nextId.current++}`,
          role: 'user',
          context: attachments.map((a) => a.label),
          text
        }
      ])
      setAttachments([])
      window.reconix.copilot.send(text).catch((err: unknown) => {
        setMessages((current) => [
          ...current,
          { id: `asst-${nextId.current++}`, role: 'assistant', used: 'OpenCode', text: `⚠ ${String(err)}` }
        ])
      })
    },
    [attachments]
  )

  return { messages, attachments, attach, detach, send }
}
