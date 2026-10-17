import chat from '../../assets/icons/chat.svg'
import close from '../../assets/icons/close.svg'
import { engagement, messages } from '../../mock/data'
import Badge from '../Badge'
import Composer from './Composer'
import DropZone from './DropZone'
import Message from './Message'

function CopilotPanel(): JSX.Element {
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

      <div className="copilot__messages">
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        <div className="copilot__spacer" />
        {/* will make this a drag-state driven once I implement DevTools drag */}
        <DropZone />
      </div>

      <Composer />
    </aside>
  )
}

export default CopilotPanel
