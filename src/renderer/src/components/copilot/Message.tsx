import type { CopilotMessage } from '../../mock/data'
import ContextChip from './ContextChip'

// All target-derived content (message.text, context labels, mapping field/column,
// footnote) is rendered through React `{value}` interpolation, i.e. as text nodes.
// No dangerouslySetInnerHTML / innerHTML anywhere here — reflected payloads and tool
// output can never be parsed as markup. Keep it this way (ARCHITECTURE §5.A).
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
        <span className="message__used">{message.used}</span>
      </header>
      <p className="message__text">{message.text}</p>
      {message.mapping && (
        <dl className="message__mapping">
          {message.mapping.map(({ field, column }) => (
            <div key={field} className="message__mapping-row">
              <dt>{field}</dt>
              <dd>{column}</dd>
            </div>
          ))}
        </dl>
      )}
      {message.footnote && <p className="message__text message__text--muted">{message.footnote}</p>}
    </article>
  )
}

export default Message
