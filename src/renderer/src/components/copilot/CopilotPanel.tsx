import { useEffect, useRef, useState, type DragEvent } from 'react'
import chat from '../../assets/icons/chat.svg'
import close from '../../assets/icons/close.svg'
import type { Copilot, NodeRef } from '../../hooks/useCopilot'
import { NODE_DRAG_TYPE } from '../../lib/dragTypes'
import { engagement } from '../../mock/data'
import Badge from '../Badge'
import Composer from './Composer'
import DropZone from './DropZone'
import Message from './Message'

type CopilotPanelProps = {
  copilot: Copilot
  /** The DOM node currently being dragged out of DevTools, if any. */
  draggedNode: NodeRef | null
  onNodeDrop: () => void
}

function CopilotPanel({ copilot, draggedNode, onNodeDrop }: CopilotPanelProps): JSX.Element {
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
    <aside className="copilot" aria-label="Copilot">
      <header className="copilot__header">
        <img src={chat} width={16} height={16} alt="" />
        <h2 className="copilot__title">Copilot</h2>
        <Badge>{engagement}</Badge>
        <button type="button" className="icon-button" aria-label="Close Copilot">
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

      <Composer attachments={attachments} onDetach={detach} onSend={send} />
    </aside>
  )
}

export default CopilotPanel
