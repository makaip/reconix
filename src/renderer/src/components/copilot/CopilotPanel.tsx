import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import chat from '../../assets/icons/chat.svg'
import close from '../../assets/icons/close.svg'
import type { Copilot } from '../../hooks/useCopilot'
import {
  NODE_DRAG_TYPE,
  RESOURCE_DRAG_TYPE,
  readDragItems,
  type NodeDragItem,
  type ResourceDragItem
} from '../../lib/dragTypes'
import { engagement } from '../../mock/data'
import Composer from './Composer'
import DropZone from './DropZone'
import Message from './Message'

type CopilotPanelProps = {
  copilot: Copilot
  /** True while any attachable item (DOM node or file) is being dragged. */
  dragActive: boolean
  onDrop: () => void
  onClose: () => void
  requestCount: number
  style?: CSSProperties
}

function CopilotPanel({
  copilot,
  dragActive,
  onDrop,
  onClose,
  requestCount,
  style
}: CopilotPanelProps): JSX.Element {
  const { messages, attachments, thinking, busy, attachNodes, attachResources, detach, send, suspend } = copilot
  const [over, setOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dragActive) setOver(false)
  }, [dragActive])

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages.length, thinking])

  const acceptsDrag = (event: DragEvent): boolean =>
    event.dataTransfer.types.includes(NODE_DRAG_TYPE) || event.dataTransfer.types.includes(RESOURCE_DRAG_TYPE)

  return (
    <aside className="copilot" aria-label="Copilot" style={style}>
      <header className="copilot__header">
        <img src={chat} width={16} height={16} alt="" />
        <h2 className="copilot__title">Copilot</h2>
        <span className="copilot__engagement">{engagement}</span>
        {busy && (
          <button type="button" className="copilot__suspend" onClick={suspend}>
            Suspend
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Close Copilot" onClick={onClose}>
          <img src={close} width={14} height={14} alt="" />
        </button>
      </header>

      <div
        ref={listRef}
        className="copilot__messages"
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
          if (resourceData) attachResources(readDragItems<ResourceDragItem>(resourceData))
          setOver(false)
          onDrop()
        }}
      >
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {thinking && (
          <div className="thinking" role="status" aria-label="Copilot is thinking">
            <span className="thinking__author">Copilot</span>
            <span className="thinking__dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
        <div className="copilot__spacer" />
        {dragActive && <DropZone over={over} />}
      </div>

      <Composer
        attachments={attachments}
        onDetach={detach}
        onSend={send}
        requestCount={requestCount}
      />
    </aside>
  )
}

export default CopilotPanel
