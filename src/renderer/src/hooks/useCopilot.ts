import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeContext } from '../../../shared/devtools'
import type { AgentEvent } from '../../../shared/contracts'
import { isSubagentTool, type CopilotMessage, type TranscriptPart } from '../components/copilot/transcript'

/** A DOM node being dragged out of DevTools. */
export type NodeRef = { nodeId: number; label: string; selector: string }

export type ContextAttachment = NodeRef & NodeContext & { id: number }

export type Copilot = {
  messages: CopilotMessage[]
  attachments: ContextAttachment[]
  /** True from send() until the first visible content comes back (a text
   *  delta, tool call, or an error) — covers the dead air while the agent is
   *  reasoning before anything is on screen yet. */
  thinking: boolean
  /** True while a turn is in flight — drives the Suspend button. */
  busy: boolean
  attach: (node: NodeRef) => Promise<void>
  detach: (id: number) => void
  send: (text: string) => void
  /** Interrupts the agent's current turn (OpenCode session interrupt) without
   *  killing the session — the user can send another message right after. */
  suspend: () => void
}

function appendPart(parts: TranscriptPart[], part: TranscriptPart): TranscriptPart[] {
  const last = parts[parts.length - 1]
  if (part.kind === 'text' && last?.kind === 'text') {
    return [...parts.slice(0, -1), { kind: 'text', text: last.text + part.text }]
  }
  if (part.kind === 'reasoning' && last?.kind === 'reasoning') {
    return [...parts.slice(0, -1), { kind: 'reasoning', text: last.text + part.text }]
  }
  return [...parts, part]
}

export function useCopilot(): Copilot {
  const [messages, setMessages] = useState<CopilotMessage[]>([])
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const nextId = useRef(1)

  // Tracks which assistant CopilotMessage.id owns a given OpenCode
  // messageId, so repeated events for the same turn accumulate into one
  // bubble instead of appending a new one per chunk.
  const assistantByMessageId = useRef(new Map<string, string>())
  // Tracks which assistant bubble a given tool callId's part lives in, so a
  // later tool.result can find and update the right pending ToolPart. Tool
  // calls don't carry a messageId, only a callId — they belong to whichever
  // turn is currently open.
  const activeAssistantId = useRef<string | null>(null)
  const toolOwner = useRef(new Map<string, string>())

  useEffect(() => {
    const ensureAssistant = (messageId: string | undefined): string => {
      const key = messageId ?? '__pending__'
      const existing = assistantByMessageId.current.get(key) ?? activeAssistantId.current
      if (existing) return existing
      const id = `asst-${nextId.current++}`
      assistantByMessageId.current.set(key, id)
      activeAssistantId.current = id
      setMessages((current) => [...current, { id, role: 'assistant', parts: [] }])
      return id
    }

    const addPart = (messageId: string | undefined, part: TranscriptPart): void => {
      const id = ensureAssistant(messageId)
      setMessages((current) =>
        current.map((m) => (m.id === id && m.role === 'assistant' ? { ...m, parts: appendPart(m.parts, part) } : m))
      )
    }

    const updateTool = (callId: string, patch: Partial<Extract<TranscriptPart, { kind: 'tool' }>>): void => {
      const id = toolOwner.current.get(callId)
      if (!id) return
      setMessages((current) =>
        current.map((m) =>
          m.id === id && m.role === 'assistant'
            ? {
                ...m,
                parts: m.parts.map((p) => (p.kind === 'tool' && p.callId === callId ? { ...p, ...patch } : p))
              }
            : m
        )
      )
    }

    const unsubscribe = window.reconix.copilot.onEvent((ev: AgentEvent) => {
      switch (ev.kind) {
        case 'message.delta': {
          setThinking(false)
          addPart(ev.messageId, { kind: 'text', text: ev.text })
          return
        }
        case 'reasoning.delta': {
          setThinking(false)
          addPart(ev.messageId, { kind: 'reasoning', text: ev.text })
          return
        }
        case 'tool.call': {
          setThinking(false)
          setBusy(true)
          const id = ensureAssistant(undefined)
          toolOwner.current.set(ev.callId, id)
          setMessages((current) =>
            current.map((m) =>
              m.id === id && m.role === 'assistant'
                ? {
                    ...m,
                    parts: appendPart(m.parts, {
                      kind: 'tool',
                      callId: ev.callId,
                      tool: ev.tool,
                      params: ev.params,
                      riskTier: ev.riskTier,
                      target: ev.target,
                      status: 'pending',
                      isSubagent: isSubagentTool(ev.tool)
                    })
                  }
                : m
            )
          )
          return
        }
        case 'tool.result': {
          updateTool(ev.callId, { status: ev.ok ? 'ok' : 'error', error: ev.error })
          toolOwner.current.delete(ev.callId)
          return
        }
        case 'error': {
          setThinking(false)
          setBusy(false)
          const id = `asst-${nextId.current++}`
          setMessages((current) => [
            ...current,
            { id, role: 'assistant', parts: [{ kind: 'text', text: `⚠ ${ev.message}` }] }
          ])
          return
        }
        case 'turn.done':
          setThinking(false) // safety net — a turn that produced no text (e.g. a tool-only turn)
          setBusy(false)
          assistantByMessageId.current.clear()
          activeAssistantId.current = null
          return
        case 'approval.request':
        case 'approval.resolved':
          // No approval UI yet (ARCHITECTURE §6.1 defines the flow; this
          // panel doesn't surface a prompt/response affordance for it) —
          // dropped here, not lost: persist() in main still writes every
          // raw event through for the audit trail.
          return
        default:
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
      setThinking(true)
      setBusy(true)
      window.reconix.copilot.send(text).catch((err: unknown) => {
        setThinking(false)
        setBusy(false)
        setMessages((current) => [
          ...current,
          { id: `asst-${nextId.current++}`, role: 'assistant', parts: [{ kind: 'text', text: `⚠ ${String(err)}` }] }
        ])
      })
    },
    [attachments]
  )

  const suspend = useCallback(() => {
    window.reconix.copilot.interrupt().finally(() => setBusy(false))
  }, [])

  return { messages, attachments, thinking, busy, attach, detach, send, suspend }
}
