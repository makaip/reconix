import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, ApprovalDecision } from '../../../shared/agent'
import type { NodeContext } from '../../../shared/devtools'
import { reduceTranscript, type TranscriptItem } from './transcript'

/** A DOM node being dragged out of DevTools. */
export type NodeRef = { nodeId: number; label: string; selector: string }

/** A source/sitemap file being dragged into Copilot. */
export type ResourceRef = { url: string; label: string; frameId?: string }

export type NodeAttachment = { kind: 'node'; id: number } & NodeRef & NodeContext
export type ResourceAttachment = { kind: 'resource'; id: number } & ResourceRef
export type ContextAttachment = NodeAttachment | ResourceAttachment

export type Copilot = {
  messages: TranscriptItem[]
  attachments: ContextAttachment[]
  /** Attach DOM nodes (fetches outerHTML/styles for each); de-duped by selector. */
  attachNodes: (nodes: NodeRef[]) => Promise<void>
  /** Attach source/sitemap files; de-duped by URL. */
  attachResources: (resources: ResourceRef[]) => void
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

  const attachNodes = useCallback(async (nodes: NodeRef[]) => {
    for (const node of nodes) {
      const context = await window.reconix.devtools.getNodeContext(node.nodeId)
      if (!context) continue
      setAttachments((current) =>
        current.some((a) => a.kind === 'node' && a.selector === node.selector)
          ? current
          : [...current, { kind: 'node', id: nextId.current++, ...node, ...context }]
      )
    }
  }, [])

  const attachResources = useCallback((resources: ResourceRef[]) => {
    setAttachments((current) => {
      const next = [...current]
      for (const resource of resources) {
        if (next.some((a) => a.kind === 'resource' && a.url === resource.url)) continue
        next.push({ kind: 'resource', id: nextId.current++, ...resource })
      }
      return next
    })
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

  return { messages, attachments, attachNodes, attachResources, detach, send, respondApproval }
}
