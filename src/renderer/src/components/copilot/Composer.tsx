import { useState } from 'react'
import send from '../../assets/icons/send.svg'
import type { ContextAttachment } from '../../hooks/useCopilot'
import Badge from '../Badge'
import ContextChip from './ContextChip'

type ComposerProps = {
  attachments: ContextAttachment[]
  onDetach: (id: number) => void
  onSend: (text: string) => void
  /** Requests captured for the current tab. */
  requestCount: number
}

function Composer({ attachments, onDetach, onSend, requestCount }: ComposerProps): JSX.Element {
  const [text, setText] = useState('')

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (!text.trim()) return
        onSend(text.trim())
        setText('')
      }}
    >
      <div className="composer__context">
        <span className="composer__context-label">Context:</span>
        {['current tab', `${requestCount} requests`, 'scope'].map((label) => (
          <Badge key={label}>{label}</Badge>
        ))}
      </div>
      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map((attachment) => (
            <ContextChip
              key={attachment.id}
              label={attachment.label}
              onRemove={() => onDetach(attachment.id)}
            />
          ))}
        </div>
      )}
      <div className="composer__field">
        <input
          className="composer__input"
          type="text"
          placeholder="Ask about this target, or type / for commands"
          aria-label="Message Copilot"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="composer__send" aria-label="Send">
          <img src={send} width={14} height={14} alt="" />
        </button>
      </div>
    </form>
  )
}

export default Composer
