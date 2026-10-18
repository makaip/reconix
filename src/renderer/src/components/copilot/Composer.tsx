import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import send from '../../assets/icons/send.svg'
import type { ContextAttachment } from '../../hooks/useCopilot'
import { matchCommands, type SlashCommand } from './commands'
import ContextChip from './ContextChip'

/** What the composer asks the panel to do with a submitted string. The panel
 *  returns the text the input should hold next: null clears it, a string
 *  replaces it (used so "/help" can reopen the full command list). */
export type SubmitResult = { text: string | null }

type ComposerProps = {
  attachments: ContextAttachment[]
  onDetach: (id: number) => void
  /** Handle a submitted string (message or slash command); returns the next input value. */
  onSubmit: (text: string) => SubmitResult
  /** Requests captured for the current tab. */
  requestCount: number
  busy: boolean
  onStop: () => void
  /** Tab the Copilot acts on. Shown in the context line so it isn't a separate banner. */
  targetTitle: string
  targetHost: string
  targetUrl?: string
  /** True when the user is viewing a different tab than the one in context. */
  viewingDifferentTab: boolean
  onUseViewedTab: () => void
}

/** The command-name fragment being typed, or null when the input is not a bare
 *  "/name" (a space, "//" escape, or non-slash text all mean no completion). */
function slashFragment(text: string): string | null {
  if (!text.startsWith('/') || text.startsWith('//')) return null
  if (text.includes(' ')) return null
  return text.slice(1)
}

function Composer({
  attachments,
  onDetach,
  onSubmit,
  requestCount,
  busy,
  onStop,
  targetTitle,
  targetHost,
  targetUrl,
  viewingDifferentTab,
  onUseViewedTab
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  // Set when the user presses Escape; cleared on the next edit so the popup
  // stays dismissed without fighting their keystrokes.
  const [dismissed, setDismissed] = useState(false)
  const target = targetHost || targetTitle
  const requestLabel = `${requestCount} ${requestCount === 1 ? 'request' : 'requests'}`

  const fragment = slashFragment(text)
  const matches = useMemo(() => (fragment === null ? [] : matchCommands(fragment)), [fragment])
  const popupOpen = fragment !== null && !dismissed && matches.length > 0

  // Keep the highlight in range as the list changes under the user.
  useEffect(() => {
    setSelected((index) => (index >= matches.length ? 0 : index))
  }, [matches.length])

  const edit = (value: string): void => {
    setText(value)
    setDismissed(false)
  }

  const submit = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    const result = onSubmit(trimmed)
    setText(result.text ?? '')
    setSelected(0)
    setDismissed(false)
  }

  // Accept a command from the popup: commands that take arguments are completed
  // in place (name + space) so the user can type them; the rest run immediately.
  const accept = (command: SlashCommand): void => {
    if (command.argHint) edit(`/${command.name} `)
    else submit(`/${command.name}`)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!popupOpen) {
      if (event.key === 'Escape' && text) {
        event.preventDefault()
        edit('')
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((index) => (index + 1) % matches.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((index) => (index - 1 + matches.length) % matches.length)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(true)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const command = matches[selected] ?? matches[0]
      if (command) accept(command)
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit(text)
      }}
    >
      {popupOpen && (
        <ul className="command-menu" role="listbox" aria-label="Slash commands">
          {matches.map((command, index) => (
            <li
              key={`${command.category}:${command.name}`}
              role="option"
              aria-selected={index === selected}
              className={`command-menu__item${index === selected ? ' command-menu__item--active' : ''}`}
              // onMouseDown (not onClick) so the input never loses focus first.
              onMouseDown={(event) => {
                event.preventDefault()
                accept(command)
              }}
              onMouseEnter={() => setSelected(index)}
            >
              <span className="command-menu__name">
                <code>
                  /{command.name}
                  {command.argHint ? ` ${command.argHint}` : ''}
                </code>
                <span className={`command-menu__tag command-menu__tag--${command.category}`}>{command.category}</span>
                {command.pending && <span className="command-menu__pending">pending</span>}
              </span>
              <span className="command-menu__desc">{command.description}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="composer__context">
        <span className="composer__context-target" title={targetUrl}>{target || 'No active tab'}</span>
        <span className="composer__context-sep" aria-hidden="true">·</span>
        <span className="composer__context-meta">{requestLabel}</span>
        {viewingDifferentTab && (
          <button type="button" className="composer__retarget" onClick={onUseViewedTab}>
            Use current tab
          </button>
        )}
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
          placeholder={busy ? 'Type a follow-up to queue it' : 'Ask about this target, or type / for commands'}
          aria-label="Message Copilot"
          value={text}
          onChange={(event) => edit(event.target.value)}
          onKeyDown={handleKeyDown}
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
