import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import chat from '../../assets/icons/chat.svg'
import close from '../../assets/icons/close.svg'
import clock from '../../assets/icons/clock.svg'
import plus from '../../assets/icons/plus.svg'
import restrictionsIcon from '../../assets/icons/restrictions.svg'
import tools from '../../assets/icons/tools.svg'
import type { Copilot } from '../../hooks/useCopilot'
import { useEngineStatus } from '../../hooks/useEngineStatus'
import type { TabInfo } from '../../../../shared/tabs'
import {
  NODE_DRAG_TYPE,
  REQUEST_DRAG_TYPE,
  RESOURCE_DRAG_TYPE,
  readDragItems,
  type NodeDragItem,
  type RequestDragItem,
  type ResourceDragItem
} from '../../lib/dragTypes'
import Composer, { type SubmitResult } from './Composer'
import { interpret, type CommandContext, type CommandPanel } from './commands'
import DropZone from './DropZone'
import Message from './Message'

type CopilotPanelProps = {
  copilot: Copilot
  /** True while any attachable item (DOM node, file or request) is being dragged. */
  dragActive: boolean
  onDrop: () => void
  onClose: () => void
  requestCount: number
  activeTab?: TabInfo
  viewedTab?: TabInfo
  onUseViewedTab: () => void
  style?: CSSProperties
}

function CopilotPanel({
  copilot,
  dragActive,
  onDrop,
  onClose,
  requestCount,
  activeTab,
  viewedTab,
  onUseViewedTab,
  style
}: CopilotPanelProps): JSX.Element {
  const {
    messages,
    attachments,
    thinking,
    busy,
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
    browserActive,
    browserAction,
    activityLabel,
    toolAccess,
    setToolEnabled,
    setAllToolsEnabled,
    attachRequests,
    restrictions,
    saveRestrictions,
    pendingQuestion,
    respondQuestion
  } = copilot
  const engine = useEngineStatus()
  const engineLabel: Record<typeof engine.status, string> = {
    starting: 'AI engine starting…',
    ready: 'AI engine online',
    offline: 'Model backend offline',
    error: 'AI engine failed to start'
  }
  const [over, setOver] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [restrictionsOpen, setRestrictionsOpen] = useState(false)
  const [restrictionsDraft, setRestrictionsDraft] = useState(restrictions)
  const listRef = useRef<HTMLDivElement>(null)
  // Whether the transcript should keep following new output. Stays true while
  // the user is at the bottom; flipping to false once they scroll up so a
  // streaming response can't yank the view back down mid-read.
  const stickToBottom = useRef(true)

  useEffect(() => {
    if (!dragActive) setOver(false)
  }, [dragActive])

  // Keep the editor seeded with the saved text until the user opens the
  // panel to edit it; once open, their in-progress draft is left alone.
  useEffect(() => {
    if (!restrictionsOpen) setRestrictionsDraft(restrictions)
  }, [restrictions, restrictionsOpen])

  useEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [messages, thinking])

  // Re-pin when the user returns to (or near) the bottom, unpin as soon as they
  // scroll away. The programmatic scroll above lands here as "at bottom".
  const handleScroll = (): void => {
    const list = listRef.current
    if (!list) return
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight
    stickToBottom.current = distanceFromBottom < 24
  }

  const acceptsDrag = (event: DragEvent): boolean =>
    event.dataTransfer.types.includes(NODE_DRAG_TYPE) ||
    event.dataTransfer.types.includes(RESOURCE_DRAG_TYPE) ||
    event.dataTransfer.types.includes(REQUEST_DRAG_TYPE)

  const targetHost = (() => {
    try {
      return activeTab?.url ? new URL(activeTab.url).host : ''
    } catch {
      return ''
    }
  })()
  const targetTitle = activeTab?.title || targetHost || 'New Tab'
  const targetLabel = activeTab ? `Target tab: ${targetTitle}${targetHost && targetHost !== targetTitle ? ` — ${targetHost}` : ''}` : undefined
  const sendToActiveTab = useCallback(
    (text: string): void => {
      stickToBottom.current = true // a fresh send should always land in view
      send(text, targetLabel)
    },
    [send, targetLabel]
  )
  const viewingDifferentTab = Boolean(viewedTab && activeTab && viewedTab.id !== activeTab.id)

  const openPanel = useCallback((panel: CommandPanel | null): void => {
    setHistoryOpen(panel === 'history')
    setToolsOpen(panel === 'tools')
    setRestrictionsOpen(panel === 'restrictions')
  }, [])

  const commandContext = useMemo<CommandContext>(
    () => ({
      send: sendToActiveTab,
      newChat: () => {
        stickToBottom.current = true
        newChat()
        openPanel(null)
      },
      suspend,
      openPanel,
      setAllToolsEnabled
    }),
    [sendToActiveTab, newChat, suspend, openPanel, setAllToolsEnabled]
  )

  // Route a submitted string: slash commands run locally or expand into a
  // prompt; everything else goes to the agent. The return value is the input's
  // next value — "/help" reopens the full list, an unknown command shows it too.
  const handleSubmit = useCallback(
    (value: string): SubmitResult => {
      const parsed = interpret(value)
      switch (parsed.kind) {
        case 'message':
          sendToActiveTab(parsed.text)
          return { text: null }
        case 'command':
          parsed.command.run(commandContext, parsed.args)
          return { text: null }
        case 'help':
        case 'unknown':
          return { text: '/' }
      }
    },
    [sendToActiveTab, commandContext]
  )

  return (
    <aside className="copilot" aria-label="Copilot" style={style}>
      <header className="copilot__header">
        <img src={chat} width={16} height={16} alt="" />
        <h2 className="copilot__title">Copilot</h2>
        <span
          className={`copilot__engine-dot copilot__engine-dot--${engine.status}`}
          title={engineLabel[engine.status]}
          aria-label={engineLabel[engine.status]}
          role="img"
        />
        {browserActive && (
          <span className="copilot__browser-state" title={browserAction ?? undefined}>
            <span aria-hidden="true" /> Browser active
          </span>
        )}
        <span className="copilot__header-spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label="Restrictions"
          title="Restrictions"
          aria-expanded={restrictionsOpen}
          onClick={() => {
            setRestrictionsOpen((open) => !open)
            setToolsOpen(false)
            setHistoryOpen(false)
          }}
        >
          <img src={restrictionsIcon} width={15} height={15} alt="" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Model functions"
          title="Model functions"
          aria-expanded={toolsOpen}
          onClick={() => {
            setToolsOpen((open) => !open)
            setHistoryOpen(false)
            setRestrictionsOpen(false)
          }}
        >
          <img src={tools} width={15} height={15} alt="" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Chat history"
          title="Chat history"
          aria-expanded={historyOpen}
          onClick={() => {
            setHistoryOpen((open) => !open)
            setToolsOpen(false)
            setRestrictionsOpen(false)
          }}
        >
          <img src={clock} width={15} height={15} alt="" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New chat"
          title="New chat"
          onClick={() => {
            stickToBottom.current = true
            newChat()
            setHistoryOpen(false)
            setToolsOpen(false)
          }}
        >
          <img src={plus} width={15} height={15} alt="" />
        </button>
        <button type="button" className="icon-button" aria-label="Close Copilot" title="Close" onClick={onClose}>
          <img src={close} width={14} height={14} alt="" />
        </button>
      </header>

      {restrictionsOpen && (
        <section className="restrictions" aria-label="Engagement restrictions">
          <div className="restrictions__heading">
            <strong>Restrictions</strong>
            <div className="restrictions__heading-actions">
              <button
                type="button"
                className="restrictions__save"
                disabled={restrictionsDraft === restrictions}
                onClick={() => saveRestrictions(restrictionsDraft)}
              >
                Save
              </button>
              <button
                type="button"
                className="icon-button restrictions__close"
                aria-label="Close restrictions"
                title="Close"
                onClick={() => setRestrictionsOpen(false)}
              >
                <img src={close} width={14} height={14} alt="" />
              </button>
            </div>
          </div>
          <p className="restrictions__note">
            Rules and policies the agent is told at the start of each chat (Markdown). Edit and save, then start a new chat to apply.
          </p>
          <textarea
            className="restrictions__editor"
            value={restrictionsDraft}
            onChange={(event) => setRestrictionsDraft(event.currentTarget.value)}
            placeholder={'e.g.\n- Only test https://staging.example.com\n- Never submit payment forms\n- No denial-of-service payloads'}
            spellCheck={false}
          />
        </section>
      )}

      {historyOpen && (
        <section className="chat-history" aria-label="Previous chats">
          <div className="chat-history__heading">
            <span>Previous chats</span>
            <button
              type="button"
              className="icon-button chat-history__close"
              aria-label="Close history"
              title="Close"
              onClick={() => setHistoryOpen(false)}
            >
              <img src={close} width={14} height={14} alt="" />
            </button>
          </div>
          {history.length === 0 ? (
            <p className="chat-history__empty">New chats will be saved here automatically.</p>
          ) : (
            <div className="chat-history__list">
              {history.map((conversation) => (
                <button
                  type="button"
                  className="chat-history__item"
                  key={conversation.id}
                  onClick={() => {
                    stickToBottom.current = true
                    showConversation(conversation.id)
                    setHistoryOpen(false)
                  }}
                >
                  <span>{conversation.title}</span>
                  <time>{new Date(conversation.updatedAt).toLocaleDateString()}</time>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {toolsOpen && (
        <section className="function-access" aria-label="Model function access">
          <div className="function-access__heading">
            <strong>Model functions</strong>
            {toolAccess.length > 0 && (
              <span className="function-access__count">
                {toolAccess.filter((tool) => tool.enabled).length}/{toolAccess.length}
              </span>
            )}
            <div className="function-access__heading-actions">
              <button type="button" onClick={() => setAllToolsEnabled(true)}>All</button>
              <button type="button" onClick={() => setAllToolsEnabled(false)}>None</button>
              <button
                type="button"
                className="icon-button function-access__close"
                aria-label="Close model functions"
                title="Close"
                onClick={() => setToolsOpen(false)}
              >
                <img src={close} width={14} height={14} alt="" />
              </button>
            </div>
          </div>
          <div className="function-access__list">
            {toolAccess.length === 0 ? (
              <p className="function-access__empty">
                Function catalog unavailable. Restart Reconix to load the updated Main process.
              </p>
            ) : toolAccess.map((tool) => (
              <label className="function-access__item" key={tool.name}>
                <input
                  type="checkbox"
                  checked={tool.enabled}
                  onChange={(event) => setToolEnabled(tool.name, event.currentTarget.checked)}
                />
                <span className="function-access__copy">
                  <span className="function-access__name">
                    <code>{tool.name}</code>
                    <span className={`function-access__tier function-access__tier--${tool.riskTier.toLowerCase()}`}>
                      {tool.riskTier}
                    </span>
                  </span>
                  <span>{tool.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="function-access__note">Disabled calls are blocked in the main process. Changes persist after restart.</p>
        </section>
      )}

      {viewingHistory && (
        <div className="chat-history__viewing">
          <span>Viewing: {viewingHistory.title}</span>
          <button type="button" onClick={closeConversation}>Back to current</button>
        </div>
      )}

      <div
        ref={listRef}
        className="copilot__messages"
        onScroll={handleScroll}
        onDragOver={(event) => {
          if (!acceptsDrag(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setOver(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
        }}
        onDrop={(event) => {
          if (!acceptsDrag(event)) return
          event.preventDefault()
          const nodeData = event.dataTransfer.getData(NODE_DRAG_TYPE)
          const resourceData = event.dataTransfer.getData(RESOURCE_DRAG_TYPE)
          if (nodeData) void attachNodes(readDragItems<NodeDragItem>(nodeData))
          const requestData = event.dataTransfer.getData(REQUEST_DRAG_TYPE)
          if (resourceData) void attachResources(readDragItems<ResourceDragItem>(resourceData))
          if (requestData) attachRequests(readDragItems<RequestDragItem>(requestData))
          setOver(false)
          onDrop()
        }}
      >
        {messages.map((message) => (
          <Message key={message.id} message={message} onReply={sendToActiveTab} onApproval={respondApproval} />
        ))}
        {busy && (
          <div className="thinking" role="status" aria-live="polite" aria-label={activityLabel ?? 'Copilot is working'}>
            <span className="thinking__author">Copilot</span>
            <span className="thinking__dots">
              <span />
              <span />
              <span />
            </span>
            <span className="thinking__label">{activityLabel ?? 'Working'}</span>
          </div>
        )}
        <div className="copilot__spacer" />
        {dragActive && <DropZone over={over} />}
      </div>

      {pendingQuestion && (
        <div className="copilot__question" role="dialog">
          <div className="copilot__question-header">{pendingQuestion.header}</div>
          <div className="copilot__question-text">{pendingQuestion.question}</div>
          {pendingQuestion.options && pendingQuestion.options.length > 0 ? (
            <div className="copilot__question-options">
              {pendingQuestion.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => respondQuestion(pendingQuestion.questionId, pendingQuestion.multiple ? [opt] : opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" onClick={() => respondQuestion(pendingQuestion.questionId, '')}>Cancel</button>
        </div>
      )}
      {viewingHistory ? (
        <div className="chat-history__readonly">Saved conversation · read only</div>
      ) : (
        <Composer
          attachments={attachments}
          onDetach={detach}
          onSubmit={handleSubmit}
          requestCount={requestCount}
          busy={busy}
          onStop={suspend}
          targetTitle={targetTitle}
          targetHost={targetHost}
          targetUrl={activeTab?.url}
          viewingDifferentTab={viewingDifferentTab}
          onUseViewedTab={onUseViewedTab}
        />
      )}
    </aside>
  )
}

export default CopilotPanel
