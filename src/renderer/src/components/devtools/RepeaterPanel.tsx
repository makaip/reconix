import { useEffect, useMemo, useState } from 'react'
import type { DiffResponsesOutput } from '../../../../shared/tools'
import type { ReplayResult, SavedRequest } from '../../../../shared/tabs'
import type { RepeaterApi } from '../../hooks/useRepeater'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/** The in-progress editor contents. `id` absent = an unsaved new request. */
type Draft = { id?: string; name: string; tags: string; method: string; url: string; headers: string; body: string }

const EMPTY: Draft = { name: '', tags: '', method: 'GET', url: '', headers: '', body: '' }

function headersToText(headers: Record<string, string> | undefined): string {
  return headers ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
}

/** Parses "Key: Value" lines into a header record; blank lines and lines without ':' are skipped. */
function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim()
    if (name) out[name] = line.slice(i + 1).trim()
  }
  return out
}

function draftFrom(saved: SavedRequest): Draft {
  return {
    id: saved.id,
    name: saved.name,
    tags: saved.tags.join(', '),
    method: saved.request.method,
    url: saved.request.url,
    headers: headersToText(saved.request.headers),
    body: saved.request.body ?? ''
  }
}

function toSaveInput(draft: Draft): { name: string; tags: string[]; request: SavedRequest['request'] } & { id?: string } {
  const headers = textToHeaders(draft.headers)
  return {
    id: draft.id,
    name: draft.name.trim() || draft.url || 'Untitled',
    tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
    request: {
      method: draft.method,
      url: draft.url.trim(),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(draft.body ? { body: draft.body } : {})
    }
  }
}

function ResponseView({ result }: { result: ReplayResult | undefined }): JSX.Element {
  if (!result) return <p className="dt-network__detail-empty">No response yet. Send the request.</p>
  if (!result.ok) {
    return <p className="rep-response__error">{result.reason}: {result.error}</p>
  }
  return (
    <div className="rep-response">
      <div className="rep-response__meta">
        <span>Status {result.status}</span>
        <span className="dt-muted">{result.timingMs} ms</span>
        {result.redirectedTo && <span className="rep-response__redirect">→ {result.redirectedTo} (not followed)</span>}
        {result.bodyTruncated && <span className="dt-muted">(truncated)</span>}
      </div>
      <pre className="rep-response__body">{result.body}</pre>
    </div>
  )
}

function DiffView({ diff }: { diff: DiffResponsesOutput | null }): JSX.Element | null {
  if (!diff) return null
  return (
    <div className="rep-diff">
      <span>{diff.bodyIdentical ? 'Bodies identical' : `${diff.changedLineCount} line(s) changed`}</span>
      <span className="dt-muted">
        status {diff.statusA}→{diff.statusB} · len {diff.lengthDelta >= 0 ? '+' : ''}{diff.lengthDelta}
      </span>
    </div>
  )
}

type RepeaterPanelProps = { api: RepeaterApi }

function RepeaterPanel({ api }: RepeaterPanelProps): JSX.Element {
  const { saved, save, remove, send, diff } = api
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [diffResult, setDiffResult] = useState<DiffResponsesOutput | null>(null)
  const [busy, setBusy] = useState(false)

  const selected = useMemo(() => saved.find((s) => s.id === selectedId) ?? null, [saved, selectedId])
  const latest = selected?.responses[selected.responses.length - 1]

  // Keep the editor in step when selecting a different saved request.
  useEffect(() => {
    if (selected) setDraft(draftFrom(selected))
    setDiffResult(null)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drop a dangling selection if the request was deleted elsewhere.
  useEffect(() => {
    if (selectedId !== null && !saved.some((s) => s.id === selectedId)) {
      setSelectedId(null)
      setDraft(EMPTY)
    }
  }, [saved, selectedId])

  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))

  const onSave = async (): Promise<void> => {
    const result = await save(toSaveInput(draft))
    if (result) setSelectedId(result.id)
  }

  const onSend = async (): Promise<void> => {
    setBusy(true)
    try {
      // Persist the current edits first so the sent request matches the editor.
      const persisted = await save(toSaveInput(draft))
      if (!persisted) return
      setSelectedId(persisted.id)
      await send(persisted.id)
    } finally {
      setBusy(false)
    }
  }

  const onDiff = async (): Promise<void> => {
    if (!selected) return
    setDiffResult(await diff({ id: selected.id }))
  }

  const newRequest = (): void => {
    setSelectedId(null)
    setDraft(EMPTY)
    setDiffResult(null)
  }

  return (
    <div className="rep">
      <div className="rep__list">
        <button type="button" className="dt-text-button rep__new" onClick={newRequest}>
          + New
        </button>
        {saved.length === 0 ? (
          <p className="dt-empty">No saved requests.</p>
        ) : (
          saved.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === selectedId ? 'rep__item rep__item--selected' : 'rep__item'}
              onClick={() => setSelectedId(s.id)}
            >
              <span className="rep__item-name">{s.name}</span>
              <span className="rep__item-method dt-muted">{s.request.method}</span>
              {s.tags.length > 0 && <span className="rep__item-tags dt-muted">{s.tags.join(', ')}</span>}
            </button>
          ))
        )}
      </div>

      <div className="rep__editor">
        <div className="rep__row">
          <input
            className="rep__input rep__input--name"
            placeholder="Name"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <input
            className="rep__input rep__input--tags"
            placeholder="tags, comma-separated"
            value={draft.tags}
            onChange={(e) => set({ tags: e.target.value })}
          />
        </div>
        <div className="rep__row">
          <select className="rep__method" value={draft.method} onChange={(e) => set({ method: e.target.value })}>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="rep__input rep__input--url"
            placeholder="https://target/path"
            value={draft.url}
            onChange={(e) => set({ url: e.target.value })}
          />
        </div>
        <label className="rep__label">Headers</label>
        <textarea
          className="rep__textarea"
          rows={4}
          placeholder={'Header: value\nHeader: value'}
          value={draft.headers}
          onChange={(e) => set({ headers: e.target.value })}
        />
        <label className="rep__label">Body</label>
        <textarea
          className="rep__textarea"
          rows={4}
          value={draft.body}
          onChange={(e) => set({ body: e.target.value })}
        />
        <div className="rep__actions">
          <button type="button" className="dt-text-button" onClick={onSave}>
            Save
          </button>
          <button type="button" className="dt-text-button rep__send" onClick={onSend} disabled={busy || !draft.url}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          {selected && selected.responses.length >= 2 && (
            <button type="button" className="dt-text-button" onClick={onDiff}>
              Diff last two
            </button>
          )}
          {selected && (
            <button
              type="button"
              className="dt-text-button rep__delete"
              onClick={() => void remove(selected.id)}
            >
              Delete
            </button>
          )}
        </div>
        <DiffView diff={diffResult} />
        <section className="rep__response-section">
          <h3>Response</h3>
          <ResponseView result={latest} />
        </section>
      </div>
    </div>
  )
}

export default RepeaterPanel
