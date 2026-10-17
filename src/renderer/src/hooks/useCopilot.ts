import { useCallback, useRef, useState } from 'react'
import type { NodeContext } from '../../../shared/devtools'
import { messages as initialMessages, type CopilotMessage } from '../mock/data'

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
  const [messages, setMessages] = useState<CopilotMessage[]>(initialMessages)
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const nextId = useRef(1)

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
    },
    [attachments]
  )

  return { messages, attachments, attach, detach, send }
}
