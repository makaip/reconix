import { useState } from 'react'
import send from '../../assets/icons/send.svg'
import type { ContextAttachment } from '../../hooks/useCopilot'
import ContextChip from './ContextChip'

type ComposerProps = {
  attachments: ContextAttachment[]
  onDetach: (id: number) => void
  onSend: (text: string) => void
  /** Requests captured for the current tab. */
  requestCount: number
  busy: boolean
  onStop: () => void
}

function Composer({ attachments, onDetach, onSend, requestCount, busy, onStop }: ComposerProps): JSX.Element {
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
      <p className="composer__context">Context: current tab · {requestCount} requests · scope</p>
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
          placeholder={busy ? 'Type a follow-up to queue it' : 'Ask about this target, or type / for commands'}
          aria-label="Message Copilot"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {busy ? (
          <button type="button" className="composer__send composer__stop" aria-label="Stop" onClick={onStop}>
            <span className="composer__stop-icon" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="composer__send" aria-label="Send">
            <img src={send} width={14} height={14} alt="" />
          </button>
        )}
      </div>
    </form>
  )
}

export default Composer
