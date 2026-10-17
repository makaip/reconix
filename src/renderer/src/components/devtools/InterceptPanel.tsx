import { useState } from 'react'
import type { InterceptApi } from '../../hooks/useIntercept'

type Draft = { name: string; urlPattern: string; header: string; action: 'set' | 'remove'; value: string }
const EMPTY: Draft = { name: '', urlPattern: '', header: '', action: 'set', value: '' }

type InterceptPanelProps = { api: InterceptApi }

function InterceptPanel({ api }: InterceptPanelProps): JSX.Element {
  const { rules, save, toggle, remove } = api
  const [draft, setDraft] = useState<Draft>(EMPTY)

  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))

  const onAdd = async (): Promise<void> => {
    if (!draft.header.trim()) return
    const created = await save({
      name: draft.name.trim() || draft.header,
      urlPattern: draft.urlPattern.trim(),
      header: draft.header.trim(),
      action: draft.action,
      value: draft.action === 'set' ? draft.value : undefined
    })
    if (created) setDraft(EMPTY)
  }

  return (
    <div className="itc">
      <p className="itc__note dt-muted">
        Rewrites request headers of the inspected tab in flight. Active only while a rule is enabled.
      </p>
      <div className="itc__form">
        <input className="rep__input" placeholder="Rule name" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        <input className="rep__input" placeholder="URL contains… (blank = all)" value={draft.urlPattern} onChange={(e) => set({ urlPattern: e.target.value })} />
        <div className="itc__form-row">
          <select className="rep__method" value={draft.action} onChange={(e) => set({ action: e.target.value as Draft['action'] })}>
            <option value="set">set</option>
            <option value="remove">remove</option>
          </select>
          <input className="rep__input" placeholder="Header" value={draft.header} onChange={(e) => set({ header: e.target.value })} />
          {draft.action === 'set' && (
            <input className="rep__input" placeholder="Value" value={draft.value} onChange={(e) => set({ value: e.target.value })} />
          )}
          <button type="button" className="dt-text-button rep__send" onClick={onAdd} disabled={!draft.header.trim()}>
            Add
          </button>
        </div>
      </div>

      {rules.length === 0 ? (
        <p className="dt-empty">No rules.</p>
      ) : (
        <ul className="itc__rules">
          {rules.map((rule) => (
            <li key={rule.id} className="itc__rule">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => void toggle(rule.id, e.target.checked)}
                aria-label={`Enable ${rule.name}`}
              />
              <span className="itc__rule-name">{rule.name}</span>
              <span className="itc__rule-desc dt-muted">
                {rule.action} <code>{rule.header}</code>
                {rule.action === 'set' && <>: {rule.value}</>}
                {rule.urlPattern && <> · when URL ⊃ “{rule.urlPattern}”</>}
              </span>
              <button type="button" className="dt-text-button rep__delete" onClick={() => void remove(rule.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default InterceptPanel
