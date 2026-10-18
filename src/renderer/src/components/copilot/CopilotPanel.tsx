import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import chat from '../../assets/icons/chat.svg'
import close from '../../assets/icons/close.svg'
import type { Copilot } from '../../hooks/useCopilot'
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
  const {
    messages,
    attachments,
    attachNodes,
    attachResources,
    attachRequests,
    detach,
    send,
    respondApproval
  } = copilot
  const [over, setOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dragActive) setOver(false)
  }, [dragActive])

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages.length])

  const acceptsDrag = (event: DragEvent): boolean =>
    event.dataTransfer.types.includes(NODE_DRAG_TYPE) ||
    event.dataTransfer.types.includes(RESOURCE_DRAG_TYPE) ||
    event.dataTransfer.types.includes(REQUEST_DRAG_TYPE)

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
          <Message key={message.id} item={message} onRespondApproval={respondApproval} />
        ))}
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
