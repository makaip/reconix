import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import chat from '../../assets/icons/chat.svg'
import close from '../../assets/icons/close.svg'
import type { Copilot, NodeRef } from '../../hooks/useCopilot'
import { NODE_DRAG_TYPE } from '../../lib/dragTypes'
import { engagement } from '../../mock/data'
import Composer from './Composer'
import DropZone from './DropZone'
import Message from './Message'

type CopilotPanelProps = {
  copilot: Copilot
  /** The DOM node currently being dragged out of DevTools, if any. */
  draggedNode: NodeRef | null
  onNodeDrop: () => void
  onClose: () => void
  requestCount: number
  style?: CSSProperties
}

function CopilotPanel({
  copilot,
  draggedNode,
  onNodeDrop,
  onClose,
  requestCount,
  style
}: CopilotPanelProps): JSX.Element {
  const { messages, attachments, attach, detach, send } = copilot
  const [over, setOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!draggedNode) setOver(false)
  }, [draggedNode])

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages.length])

  const acceptsDrag = (event: DragEvent): boolean =>
    draggedNode !== null && event.dataTransfer.types.includes(NODE_DRAG_TYPE)

  return (
    <aside className="copilot" aria-label="Copilot" style={style}>
      <header className="copilot__header">
        <img src={chat} width={16} height={16} alt="" />
        <h2 className="copilot__title">Copilot</h2>
        <span className="copilot__engagement">{engagement}</span>
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
          if (!acceptsDrag(event) || !draggedNode) return
          event.preventDefault()
          void attach(draggedNode)
          setOver(false)
          onNodeDrop()
        }}
      >
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        <div className="copilot__spacer" />
        {draggedNode && <DropZone over={over} />}
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
