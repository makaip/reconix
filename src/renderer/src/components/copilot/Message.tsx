import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CopilotMessage, ToolPart, ToolPartStatus } from './transcript'
import ContextChip from './ContextChip'

const STATUS_ICON: Record<ToolPartStatus, string> = { pending: '◌', ok: '✓', error: '✗' }

function formatParams(params: unknown): string {
  try {
    return JSON.stringify(params, null, 2)
  } catch {
    return String(params)
  }
}

function ToolBlock({ part }: { part: ToolPart }): JSX.Element {
  const [open, setOpen] = useState(false)
  const label = part.isSubagent ? `subagent: ${part.tool}` : part.tool
  return (
    <div className={`tool-block tool-block--${part.status}${part.isSubagent ? ' tool-block--subagent' : ''}`}>
      <button
        type="button"
        className="tool-block__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`tool-block__status tool-block__status--${part.status}`} aria-hidden="true">
          {STATUS_ICON[part.status]}
        </span>
        <span className="tool-block__label">{label}</span>
        {part.target && <span className="tool-block__target">{part.target}</span>}
        <span className="tool-block__tier" title="risk tier">
          {part.riskTier}
        </span>
        <span className="tool-block__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-block__body">
          <pre className="tool-block__params">{formatParams(part.params)}</pre>
          {part.status === 'error' && part.error && <p className="tool-block__error">{part.error}</p>}
        </div>
      )}
    </div>
  )
}

function ReasoningBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="reasoning-block">
      <button type="button" className="reasoning-block__summary" onClick={() => setOpen((v) => !v)}>
        <span className="reasoning-block__chevron">{open ? '▾' : '▸'}</span> reasoning
      </button>
      {open && <p className="reasoning-block__text">{text}</p>}
    </div>
  )
}

function Message({ message }: { message: CopilotMessage }): JSX.Element {
  if (message.role === 'user') {
    return (
      <article className="message message--user">
        <p className="message__author">You</p>
        <div className="message__chips">
          {message.context.map((label) => (
            <ContextChip key={label} label={label} />
          ))}
        </div>
        <p className="message__text">{message.text}</p>
      </article>
    )
  }

  return (
    <article className="message message--assistant">
      <header className="message__meta">
        <span className="message__author message__author--assistant">Copilot</span>
      </header>
      {message.parts.map((part, i) => {
        if (part.kind === 'text') {
          return (
            <div className="message__text message__markdown" key={i}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          )
        }
        if (part.kind === 'reasoning') {
          return <ReasoningBlock key={i} text={part.text} />
        }
        return <ToolBlock key={part.callId} part={part} />
      })}
    </article>
  )
}

export default Message
