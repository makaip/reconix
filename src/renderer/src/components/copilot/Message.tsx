import { useState } from 'react'
import type { ApprovalDecision } from '../../../../shared/agent'
import type { TranscriptItem } from '../../hooks/transcript'
import ContextChip from './ContextChip'

// SECURITY (ARCHITECTURE §5.A, §2): EVERY field below is agent- or target-derived
// (message text, reasoning, tool name, tool args, tool-result bodies, reflected
// payloads, approval action + diff preview) and is rendered ONLY through React
// `{value}` interpolation — i.e. as text nodes. There is NO dangerouslySetInnerHTML /
// innerHTML / insertAdjacentHTML / document.write anywhere here, so a reflected XSS
// payload can never be parsed as markup. Each structured field is interpolated
// individually; nothing is concatenated into markup. Keep it this way.

type MessageProps = {
  item: TranscriptItem
  onRespondApproval: (decision: ApprovalDecision) => void
}

function Message({ item, onRespondApproval }: MessageProps): JSX.Element {
  if (item.kind === 'user-message') {
    return (
      <article className="message message--user">
        <p className="message__author">You</p>
        <div className="message__chips">
          {item.context.map((label) => (
            <ContextChip key={label} label={label} />
          ))}
        </div>
        {/* text node only — never markup (§5.A) */}
        <p className="message__text">{item.text}</p>
      </article>
    )
  }

  if (item.kind === 'reasoning') {
    return (
      <article className="message message--assistant">
        <header className="message__meta">
          <span className="message__author message__author--assistant">Copilot</span>
        </header>
        {/* text node only — never markup (§5.A) */}
        <p className="message__text">{item.text}</p>
      </article>
    )
  }

  if (item.kind === 'tool-call') {
    return (
      <article className="message message--tool">
        <header className="message__meta">
          {/* tool name is agent-chosen — text node only (§5.A) */}
          <span className="message__author message__author--assistant">{item.tool}</span>
          <span className="message__used">{item.riskTier}</span>
        </header>
        {Object.keys(item.args).length > 0 && (
          <dl className="message__mapping">
            {Object.entries(item.args).map(([key, value]) => (
              <div key={key} className="message__mapping-row">
                {/* arg key + value are agent/target-derived — text nodes only (§5.A) */}
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {item.result && (
          <p className={item.result.ok ? 'message__text message__text--muted' : 'message__text'}>
            {/* tool-result body is target-derived — text node only (§5.A) */}
            {item.result.summary}
          </p>
        )}
      </article>
    )
  }

  // approval-request — inline approve / deny / edit controls (§6.1).
  return <ApprovalMessage item={item} onRespondApproval={onRespondApproval} />
}

type ApprovalItem = Extract<TranscriptItem, { kind: 'approval-request' }>

function ApprovalMessage({
  item,
  onRespondApproval
}: {
  item: ApprovalItem
  onRespondApproval: (decision: ApprovalDecision) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState(item.diffPreview)

  const approve = (): void =>
    onRespondApproval(
      editing
        ? { approvalId: item.approvalId, decision: 'approve', editedParams: { preview: edited } }
        : { approvalId: item.approvalId, decision: 'approve' }
    )

  const deny = (): void => onRespondApproval({ approvalId: item.approvalId, decision: 'deny' })

  return (
    <article className="message message--approval">
      <header className="message__meta">
        <span className="message__author message__author--assistant">Approval required</span>
        <span className="message__used">{item.riskTier}</span>
      </header>
      {/* action + diff preview are agent/target-derived — text nodes only (§5.A) */}
      <p className="message__text">{item.action}</p>
      {editing ? (
        <textarea
          className="approval__edit"
          aria-label="Edit action parameters"
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
        />
      ) : (
        <p className="message__text message__text--muted">{item.diffPreview}</p>
      )}

      {item.status === 'pending' ? (
        <div className="approval__controls">
          <button type="button" className="approval__btn approval__btn--approve" onClick={approve}>
            Approve
          </button>
          <button type="button" className="approval__btn approval__btn--deny" onClick={deny}>
            Deny
          </button>
          <button
            type="button"
            className="approval__btn"
            onClick={() => setEditing((on) => !on)}
            aria-pressed={editing}
          >
            {editing ? 'Cancel edit' : 'Edit'}
          </button>
        </div>
      ) : (
        // status is one of our own literals, not target content
        <p className="approval__status">{item.status}</p>
      )}
    </article>
  )
}

export default Message
