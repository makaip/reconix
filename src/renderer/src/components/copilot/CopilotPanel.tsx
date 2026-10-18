import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import chat from '../../assets/icons/chat.svg'
import close from '../../assets/icons/close.svg'
import type { Copilot } from '../../hooks/useCopilot'
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
import { engagement } from '../../mock/data'
import Composer from './Composer'
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
    attachRequests
  } = copilot
  const [over, setOver] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // Whether the transcript should keep following new output. Stays true while
  // the user is at the bottom; flipping to false once they scroll up so a
  // streaming response can't yank the view back down mid-read.
  const stickToBottom = useRef(true)

  useEffect(() => {
    if (!dragActive) setOver(false)
  }, [dragActive])

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

  return (
    <aside className="copilot" aria-label="Copilot" style={style}>
      <header className="copilot__header">
        <img src={chat} width={16} height={16} alt="" />
        <h2 className="copilot__title">Copilot</h2>
        <span className="copilot__engagement">{engagement}</span>
        {browserActive && (
          <span className="copilot__browser-state" title={browserAction ?? undefined}>
            <span aria-hidden="true" /> Browser active
          </span>
        )}
        <button
          type="button"
          className="copilot__header-action"
          aria-label="Chat history"
          aria-expanded={historyOpen}
          onClick={() => {
            setHistoryOpen((open) => !open)
            setToolsOpen(false)
          }}
        >
          History
        </button>
        <button
          type="button"
          className="copilot__header-action"
          onClick={() => {
            stickToBottom.current = true
            newChat()
          }}
        >
          New
        </button>
        <button type="button" className="icon-button" aria-label="Close Copilot" onClick={onClose}>
          <img src={close} width={14} height={14} alt="" />
        </button>
      </header>

      {historyOpen && (
        <section className="chat-history" aria-label="Previous chats">
          <div className="chat-history__heading">
            <span>Previous chats</span>
            <button type="button" onClick={() => setHistoryOpen(false)}>Done</button>
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
            <div>
              <strong>Model functions</strong>
              <span>Choose which Reconix capabilities the model can call.</span>
            </div>
            <button type="button" onClick={() => setToolsOpen(false)}>Done</button>
          </div>
          <div className="function-access__actions">
            <button type="button" onClick={() => setAllToolsEnabled(true)}>Enable all</button>
            <button type="button" onClick={() => setAllToolsEnabled(false)}>Disable all</button>
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

      {!viewingHistory && (
        <div className={`copilot-target${activeTab ? '' : ' copilot-target--empty'}`} title={activeTab?.url}>
          <span className="copilot-target__dot" aria-hidden="true" />
          <span className="copilot-target__copy">
            <span className="copilot-target__eyebrow">Active target tab</span>
            <strong>{targetTitle}</strong>
          </span>
          {targetHost && <span className="copilot-target__host">{targetHost}</span>}
          {viewingDifferentTab && (
            <button type="button" className="copilot-target__retarget" onClick={onUseViewedTab}>
              Use current tab
            </button>
          )}
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
          if (resourceData) attachResources(readDragItems<ResourceDragItem>(resourceData))
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

      {viewingHistory ? (
        <div className="chat-history__readonly">Saved conversation · read only</div>
      ) : (
        <>
          <div className="function-access-trigger">
            <button
              type="button"
              aria-expanded={toolsOpen}
              onClick={() => {
                setToolsOpen((open) => !open)
                setHistoryOpen(false)
              }}
            >
              <span>Model functions</span>
              <span className={toolAccess.length === 0 ? 'function-access-trigger__unavailable' : ''}>
                {toolAccess.length === 0
                  ? 'Unavailable'
                  : `${toolAccess.filter((tool) => tool.enabled).length} of ${toolAccess.length} enabled`}
              </span>
            </button>
          </div>
          <Composer
            attachments={attachments}
            onDetach={detach}
            onSend={sendToActiveTab}
            requestCount={requestCount}
            busy={busy}
            onStop={suspend}
          />
        </>
      )}
    </aside>
  )
}

export default CopilotPanel
