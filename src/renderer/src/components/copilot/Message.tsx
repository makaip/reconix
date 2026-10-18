import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CopilotMessage, ToolPart, ToolPartStatus, TranscriptPart } from './transcript'
import ContextChip from './ContextChip'

const STATUS_ICON: Record<ToolPartStatus, string> = { pending: '◌', ok: '✓', error: '✗' }

function formatParams(params: unknown): string {
  if (params === null || params === undefined) return '(no arguments)'
  if (typeof params === 'object' && !Array.isArray(params) && Object.keys(params).length === 0) {
    return '(no arguments)'
  }
  try {
    return JSON.stringify(params, null, 2)
  } catch {
    return String(params)
  }
}

function ToolBlock({ part, onApproval }: { part: ToolPart; onApproval: (id: string, decision: 'approve' | 'deny') => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tool-block tool-block--${part.status}`}>
      <button
        type="button"
        className="tool-block__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`tool-block__status tool-block__status--${part.status}`} aria-hidden="true">
          {STATUS_ICON[part.status]}
        </span>
        <span className="tool-block__label">{part.tool}</span>
        {part.target && <span className="tool-block__target">{part.target}</span>}
        <span className="tool-block__tier" title="risk tier">
          {part.riskTier}
        </span>
        <span className="tool-block__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-block__body">
          <p className="tool-block__body-label">Arguments</p>
          <pre className="tool-block__params">{formatParams(part.params)}</pre>
          {part.status === 'error' && part.error && <p className="tool-block__error">{part.error}</p>}
          {part.output && (
            <>
              <p className="tool-block__body-label">Output</p>
              <pre className="tool-block__output">{part.output}</pre>
            </>
          )}
        </div>
      )}
      {part.approval?.status === 'pending' && (
        <div className="tool-block__approval" role="status">
          <span className="tool-block__approval-label"><span aria-hidden="true">●</span> Approval required</span>
          <div className="tool-block__approval-actions">
            <button type="button" onClick={() => onApproval(part.approval!.id, 'deny')}>Deny</button>
            <button type="button" className="tool-block__approve" onClick={() => onApproval(part.approval!.id, 'approve')}>Approve</button>
          </div>
        </div>
      )}
      {part.approval && part.approval.status !== 'pending' && (
        <div className={`tool-block__approval-state tool-block__approval-state--${part.approval.status}`}>
          {part.approval.status === 'approved' ? 'Approved' : 'Denied'}
        </div>
      )}
    </div>
  )
}

export interface EmbeddedQuestion {
  header: string
  question: string
  options: Array<{ label: string; description?: string }>
}

/** Some OpenAI-compatible models occasionally serialize a `question` tool
 * call as assistant text instead of emitting a structured tool call. Keep that
 * provider quirk out of the UI by recognizing the narrow envelope and rendering
 * a native choice card. Arbitrary JSON is left untouched. */
export function parseEmbeddedQuestion(text: string): EmbeddedQuestion | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>
    if (value.name !== 'question' || !value.arguments || typeof value.arguments !== 'object') return null
    const questions = (value.arguments as Record<string, unknown>).questions
    if (!Array.isArray(questions) || questions.length !== 1) return null
    const item = questions[0] as Record<string, unknown>
    if (typeof item.question !== 'string' || !Array.isArray(item.options)) return null
    const options = item.options.flatMap((option) => {
      if (!option || typeof option !== 'object') return []
      const candidate = option as Record<string, unknown>
      if (typeof candidate.label !== 'string') return []
      return [{ label: candidate.label, description: typeof candidate.description === 'string' ? candidate.description : undefined }]
    })
    if (options.length === 0) return null
    return {
      header: typeof item.header === 'string' ? item.header : 'Copilot needs your input',
      question: item.question,
      options
    }
  } catch {
    return null
  }
}

/** Hide internal delegation and join the text fragments it previously split.
 * Without this pass, one logical answer renders as several stacked messages
 * after its intervening subagent call is removed. */
export function visibleTranscriptParts(parts: TranscriptPart[]): TranscriptPart[] {
  return parts.reduce<TranscriptPart[]>((visible, part) => {
    if (part.kind === 'tool' && part.isSubagent) return visible
    const previous = visible[visible.length - 1]
    if (part.kind === 'text' && previous?.kind === 'text') {
      return [...visible.slice(0, -1), { kind: 'text', text: previous.text + part.text }]
    }
    if (part.kind === 'reasoning' && previous?.kind === 'reasoning') {
      return [...visible.slice(0, -1), { kind: 'reasoning', text: previous.text + part.text }]
    }
    return [...visible, part]
  }, [])
}

function QuestionCard({ question, onReply }: { question: EmbeddedQuestion; onReply: (text: string) => void }): JSX.Element {
  return (
    <section className="question-card" aria-label={question.header}>
      <p className="question-card__eyebrow">{question.header}</p>
      <p className="question-card__prompt">{question.question}</p>
      <div className="question-card__options">
        {question.options.map((option) => (
          <button type="button" className="question-card__option" key={option.label} onClick={() => onReply(option.label)}>
            <span className="question-card__label">{option.label}</span>
            {option.description && <span className="question-card__description">{option.description}</span>}
          </button>
        ))}
      </div>
    </section>
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

// Completed text segments within a still-streaming turn can skip markdown parsing too.
const TextBlock = memo(function TextBlock({ text, onReply }: { text: string; onReply: (text: string) => void }): JSX.Element {
  const question = parseEmbeddedQuestion(text)
  if (question) return <QuestionCard question={question} onReply={onReply} />
  return (
    <div className="message__text message__markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
})

function Message({
  message,
  onReply,
  onApproval
}: {
  message: CopilotMessage
  onReply: (text: string) => void
  onApproval: (id: string, decision: 'approve' | 'deny') => void
}): JSX.Element {
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
        {message.status !== 'sent' && (
          <span className={`message__state message__state--${message.status}`}>
            {message.status === 'queued' ? 'Queued' : 'Not sent'}
          </span>
        )}
      </article>
    )
  }

  // Delegation is internal orchestration. Child-session output is filtered in
  // Main, and its task/tool wrapper should be invisible too—not replaced with
  // a status caption beneath every answer. Suppress an otherwise-empty bubble.
  const visibleParts = visibleTranscriptParts(message.parts)
  if (visibleParts.length === 0) return <></>

  return (
    <article className="message message--assistant">
      <header className="message__meta">
        <span className="message__author message__author--assistant">Copilot</span>
      </header>
      {visibleParts.map((part, i) => {
        if (part.kind === 'text') {
          return <TextBlock key={i} text={part.text} onReply={onReply} />
        }
        if (part.kind === 'reasoning') {
          return <ReasoningBlock key={i} text={part.text} />
        }
        return <ToolBlock key={part.callId} part={part} onApproval={onApproval} />
      })}
    </article>
  )
}

export default memo(Message)
