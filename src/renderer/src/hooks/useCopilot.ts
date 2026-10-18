import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeContext } from '../../../shared/devtools'
import type { AgentEvent, ToolAccess } from '../../../shared/contracts'
import { isBrowserTool, isSubagentTool, type CopilotMessage, type TranscriptPart } from '../components/copilot/transcript'
import type { CapturedRequest } from '../../../shared/tabs'

/** A DOM node being dragged out of DevTools. */
export type NodeRef = { nodeId: number; label: string; selector: string }

/** A source/sitemap file being dragged into Copilot. */
export type ResourceRef = { url: string; label: string; frameId?: string }

/** A captured network request being dragged into Copilot (snapshot taken at drag time). */
export type RequestRef = CapturedRequest & { label: string }

export type NodeAttachment = { kind: 'node'; id: number } & NodeRef & NodeContext
export type ResourceAttachment = { kind: 'resource'; id: number } & ResourceRef
export type RequestAttachment = Omit<RequestRef, 'id'> & { kind: 'request'; id: number; requestId: string }
export type ContextAttachment = NodeAttachment | ResourceAttachment | RequestAttachment

export type SavedConversation = {
  id: string
  title: string
  updatedAt: number
  messages: CopilotMessage[]
}

const CURRENT_CHAT_KEY = 'reconix:copilot:current:v1'
const CHAT_HISTORY_KEY = 'reconix:copilot:history:v1'

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

function restoreMessages(messages: CopilotMessage[]): CopilotMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      if (message.status === 'queued') return { ...message, status: 'failed' }
      return { ...message, status: message.status ?? 'sent' }
    }
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.kind === 'tool' && part.status === 'pending'
          ? { ...part, status: 'error', error: 'Interrupted when the application closed' }
          : part
      )
    }
  })
}

export type Copilot = {
  messages: CopilotMessage[]
  attachments: ContextAttachment[]
  /** True from send() until the first visible content comes back (a text
   *  delta, tool call, or an error) — covers the dead air while the agent is
   *  reasoning before anything is on screen yet. */
  thinking: boolean
  /** True while a turn is in flight — drives the Suspend button. */
  busy: boolean
  /** Attach DOM nodes (fetches outerHTML/styles for each); de-duped by selector. */
  attachNodes: (nodes: NodeRef[]) => Promise<void>
  /** Attach source/sitemap files; de-duped by URL. */
  attachResources: (resources: ResourceRef[]) => void
  /** Attach captured network requests; de-duped by request id. */
  attachRequests: (requests: RequestRef[]) => void
  detach: (id: number) => void
  send: (text: string, targetLabel?: string) => void
  /** Interrupts the agent's current turn (OpenCode session interrupt) without
   *  killing the session — the user can send another message right after. */
  suspend: () => void
  respondApproval: (approvalId: string, decision: 'approve' | 'deny') => void
  history: SavedConversation[]
  viewingHistory: SavedConversation | null
  showConversation: (id: string) => void
  closeConversation: () => void
  newChat: () => void
  browserActive: boolean
  browserAction: string | null
  activityLabel: string | null
  toolAccess: ToolAccess[]
  setToolEnabled: (name: string, enabled: boolean) => void
  setAllToolsEnabled: (enabled: boolean) => void
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
  // Every application launch starts a fresh Copilot conversation. The prior
  // conversation remains available through Chat history, but it is never
  // restored into the active panel automatically.
  const initial = useRef<SavedConversation>({
    id: `chat-${Date.now()}`,
    title: 'New chat',
    updatedAt: Date.now(),
    messages: []
  }).current
  const [messages, setMessages] = useState<CopilotMessage[]>(() => restoreMessages(initial.messages))
  const [conversationId, setConversationId] = useState(initial.id)
  const [conversationTitle, setConversationTitle] = useState(initial.title)
  const [history, setHistory] = useState<SavedConversation[]>(() =>
    readStored<SavedConversation[]>(CHAT_HISTORY_KEY, []).map((conversation) => ({
      ...conversation,
      messages: restoreMessages(conversation.messages)
    }))
  )
  const [viewingHistory, setViewingHistory] = useState<SavedConversation | null>(null)
  const [browserAction, setBrowserAction] = useState<string | null>(null)
  const [activityLabel, setActivityLabel] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toolAccess, setToolAccess] = useState<ToolAccess[]>([])
  const busyRef = useRef(false)
  const queued = useRef<Array<{ messageId: string; text: string }>>([])
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
  const browserCalls = useRef(new Map<string, string>())

  useEffect(() => {
    localStorage.setItem(
      CURRENT_CHAT_KEY,
      JSON.stringify({ id: conversationId, title: conversationTitle, updatedAt: Date.now(), messages })
    )
  }, [conversationId, conversationTitle, messages])

  useEffect(() => {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(history.slice(0, 50)))
  }, [history])

  useEffect(() => {
    void window.reconix.copilot.getToolAccess().then(setToolAccess).catch(() => undefined)
  }, [])

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

    function failMessage(messageId: string, err: unknown): void {
      setThinking(false)
      setActivityLabel(null)
      setMessages((current) => [
        ...current.map((message) =>
          message.id === messageId && message.role === 'user' ? { ...message, status: 'failed' as const } : message
        ),
        { id: `asst-${nextId.current++}`, role: 'assistant', parts: [{ kind: 'text', text: `⚠ ${String(err)}` }] }
      ])
      if (!runNextQueued()) {
        busyRef.current = false
        setBusy(false)
      }
    }

    function runNextQueued(): boolean {
      const next = queued.current.shift()
      if (!next) return false
      assistantByMessageId.current.clear()
      activeAssistantId.current = null
      busyRef.current = true
      setBusy(true)
      setThinking(true)
      setActivityLabel('Preparing response')
      setMessages((current) =>
        current.map((message) =>
          message.id === next.messageId && message.role === 'user' ? { ...message, status: 'sent' } : message
        )
      )
      window.reconix.copilot.send(next.text).catch((err: unknown) => failMessage(next.messageId, err))
      return true
    }

    const unsubscribe = window.reconix.copilot.onEvent((ev: AgentEvent) => {
      switch (ev.kind) {
        case 'message.delta': {
          setThinking(false)
          busyRef.current = true
          setBusy(true)
          setActivityLabel('Writing response')
          addPart(ev.messageId, { kind: 'text', text: ev.text })
          return
        }
        case 'reasoning.delta': {
          setThinking(true)
          busyRef.current = true
          setBusy(true)
          setActivityLabel('Preparing response')
          addPart(ev.messageId, { kind: 'reasoning', text: ev.text })
          return
        }
        case 'tool.call': {
          setThinking(false)
          busyRef.current = true
          setBusy(true)
          setActivityLabel(isBrowserTool(ev.tool) ? 'Controlling browser' : `Running ${ev.tool}`)
          const id = ensureAssistant(undefined)
          toolOwner.current.set(ev.callId, id)
          if (isBrowserTool(ev.tool)) {
            browserCalls.current.set(ev.callId, ev.tool)
            setBrowserAction(ev.tool)
          }
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
          if (browserCalls.current.delete(ev.callId)) {
            const remaining = Array.from(browserCalls.current.values())
            setBrowserAction(remaining.at(-1) ?? null)
          }
          setThinking(true)
          setActivityLabel('Preparing response')
          return
        }
        case 'error': {
          setThinking(false)
          setBusy(false)
          busyRef.current = false
          browserCalls.current.clear()
          setBrowserAction(null)
          setActivityLabel(null)
          const id = `asst-${nextId.current++}`
          setMessages((current) => [
            ...current,
            { id, role: 'assistant', parts: [{ kind: 'text', text: `⚠ ${ev.message}` }] }
          ])
          return
        }
        case 'turn.done':
          assistantByMessageId.current.clear()
          activeAssistantId.current = null
          browserCalls.current.clear()
          setBrowserAction(null)
          if (!runNextQueued()) {
            setThinking(false) // safety net — a turn that produced no text (e.g. a tool-only turn)
            setBusy(false)
            busyRef.current = false
            setActivityLabel(null)
          }
          return
        case 'approval.request': {
          setThinking(false)
          busyRef.current = true
          setBusy(true)
          setActivityLabel('Waiting for approval')
          const id = ensureAssistant(undefined)
          setMessages((current) =>
            current.map((message) => {
              if (message.id !== id || message.role !== 'assistant') return message
              const index = message.parts.findLastIndex(
                (part) => part.kind === 'tool' && part.status === 'pending' && !part.isSubagent
              )
              if (index >= 0) {
                const parts = [...message.parts]
                const part = parts[index]
                if (part.kind === 'tool') parts[index] = { ...part, approval: { id: ev.approvalId, status: 'pending' } }
                return { ...message, parts }
              }
              return {
                ...message,
                parts: appendPart(message.parts, {
                  kind: 'tool',
                  callId: ev.callId || `approval:${ev.approvalId}`,
                  tool: ev.tool,
                  params: ev.params,
                  riskTier: ev.riskTier,
                  target: ev.target,
                  status: 'pending',
                  isSubagent: false,
                  approval: { id: ev.approvalId, status: 'pending' }
                })
              }
            })
          )
          return
        }
        case 'approval.resolved':
          setThinking(true)
          setActivityLabel('Resuming tool')
          setMessages((current) =>
            current.map((message) =>
              message.role === 'assistant'
                ? {
                    ...message,
                    parts: message.parts.map((part) =>
                      part.kind === 'tool' && part.approval?.id === ev.approvalId
                        ? { ...part, approval: { ...part.approval, status: ev.decision === 'approve' ? 'approved' : 'denied' } }
                        : part
                    )
                  }
                : message
            )
          )
          return
        default:
          return
      }
    })
    return unsubscribe
  }, [])

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

  const attachRequests = useCallback((requests: RequestRef[]) => {
    setAttachments((current) => {
      const next = [...current]
      for (const { id: requestId, ...request } of requests) {
        if (next.some((a) => a.kind === 'request' && a.requestId === requestId)) continue
        next.push({ ...request, kind: 'request', id: nextId.current++, requestId })
      }
      return next
    })
  }, [])

  const detach = useCallback((id: number) => {
    setAttachments((current) => current.filter((a) => a.id !== id))
  }, [])

  const send = useCallback(
    (text: string, targetLabel?: string) => {
      // OpenCode treats a prompt sent during an active turn as a steer. Start a
      // fresh visual response boundary now; otherwise later deltas carrying the
      // same assistantMessageID are appended to the bubble above this new user
      // message, making the transcript appear out of order.
      assistantByMessageId.current.clear()
      activeAssistantId.current = null
      const messageId = `user-${nextId.current++}`
      const isQueued = busyRef.current
      setMessages((current) => [
        ...current,
        {
          id: messageId,
          role: 'user',
          context: [targetLabel, ...attachments.map((a) => a.label)].filter((label): label is string => Boolean(label)),
          text,
          status: isQueued ? 'queued' : 'sent'
        }
      ])
      setAttachments([])
      if (conversationTitle === 'New chat') setConversationTitle(text.slice(0, 48))
      if (isQueued) {
        queued.current.push({ messageId, text })
        return
      }
      busyRef.current = true
      setThinking(true)
      setBusy(true)
      setActivityLabel('Preparing response')
      window.reconix.copilot.send(text).catch((err: unknown) => {
        busyRef.current = false
        setThinking(false)
        setBusy(false)
        setActivityLabel(null)
        setMessages((current) => [
          ...current.map((message) =>
            message.id === messageId && message.role === 'user' ? { ...message, status: 'failed' as const } : message
          ),
          { id: `asst-${nextId.current++}`, role: 'assistant', parts: [{ kind: 'text', text: `⚠ ${String(err)}` }] }
        ])
      })
    },
    [attachments, conversationTitle]
  )

  const suspend = useCallback(() => {
    setThinking(false)
    setActivityLabel('Stopping')
    window.reconix.copilot.interrupt().catch(() => undefined)
  }, [])

  const respondApproval = useCallback((approvalId: string, decision: 'approve' | 'deny') => {
    void window.reconix.copilot.respondApproval(approvalId, decision)
  }, [])

  const applyEnabledTools = useCallback((names: string[]) => {
    void window.reconix.copilot.setEnabledTools(names).then(setToolAccess).catch(() => undefined)
  }, [])

  const setToolEnabled = useCallback(
    (name: string, enabled: boolean) => {
      const names = toolAccess
        .filter((tool) => (tool.name === name ? enabled : tool.enabled))
        .map((tool) => tool.name)
      setToolAccess((current) => current.map((tool) => (tool.name === name ? { ...tool, enabled } : tool)))
      applyEnabledTools(names)
    },
    [applyEnabledTools, toolAccess]
  )

  const setAllToolsEnabled = useCallback(
    (enabled: boolean) => {
      const names = enabled ? toolAccess.map((tool) => tool.name) : []
      setToolAccess((current) => current.map((tool) => ({ ...tool, enabled })))
      applyEnabledTools(names)
    },
    [applyEnabledTools, toolAccess]
  )

  const showConversation = useCallback(
    (id: string) => setViewingHistory(history.find((conversation) => conversation.id === id) ?? null),
    [history]
  )

  const closeConversation = useCallback(() => setViewingHistory(null), [])

  const newChat = useCallback(() => {
    void window.reconix.copilot
      .newChat()
      .then((id) => {
        if (messages.length > 0) {
          const archived = { id: conversationId, title: conversationTitle, updatedAt: Date.now(), messages }
          setHistory((current) =>
            [archived, ...current.filter((conversation) => conversation.id !== archived.id)].slice(0, 50)
          )
        }
        queued.current = []
        assistantByMessageId.current.clear()
        activeAssistantId.current = null
        toolOwner.current.clear()
        browserCalls.current.clear()
        setBrowserAction(null)
        setActivityLabel(null)
        busyRef.current = false
        setBusy(false)
        setThinking(false)
        setMessages([])
        setConversationId(id)
        setConversationTitle('New chat')
        setViewingHistory(null)
      })
      .catch((err: unknown) => {
        const raw = String(err)
        const message = raw.includes("No handler registered for 'copilot:new-chat'")
          ? 'Reconix needs to be restarted to finish the chat update. Your current conversation is still here.'
          : `Could not start a new chat: ${raw}`
        setMessages((current) => [
          ...current,
          { id: `asst-${nextId.current++}`, role: 'assistant', parts: [{ kind: 'text', text: `⚠ ${message}` }] }
        ])
      })
  }, [conversationId, conversationTitle, messages])

  return {
    messages: viewingHistory?.messages ?? messages,
    attachments,
    thinking: viewingHistory ? false : thinking,
    busy: viewingHistory ? false : busy,
    attachNodes,
    attachResources,
    detach,
    send,
    suspend,
    respondApproval,
    history,
    viewingHistory,
    showConversation,
    closeConversation,
    newChat,
    browserActive: browserAction !== null,
    browserAction,
    activityLabel: viewingHistory ? null : activityLabel,
    toolAccess,
    setToolEnabled,
    setAllToolsEnabled,
    attachRequests
  }
}
