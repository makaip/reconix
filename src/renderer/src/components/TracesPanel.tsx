import { useEffect, useState } from 'react'
import type { TraceDetail, TraceSummary } from '../../../shared/traces'
import { useTraces } from '../hooks/useTraces'

const KIND_LABEL: Record<TraceSummary['kind'], string> = {
  screenshot: 'Screenshot',
  reqresp: 'Request / response',
  trace: 'Trace'
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

type TracesPanelProps = {
  onClose: () => void
}

/** Browse the evidence the agent captured: screenshots render inline, text
 *  traces (reqresp / raw) as preformatted text. Reads over the traces:* IPC and
 *  follows the live push, so a capture lands here the moment it's stored. */
function TracesPanel({ onClose }: TracesPanelProps): JSX.Element {
  const traces = useTraces()
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<TraceDetail | null>(null)

  // Keep a valid selection: default to the newest trace, drop one that vanished.
  useEffect(() => {
    if (traces.length === 0) {
      if (selected !== null) setSelected(null)
      return
    }
    if (selected === null || !traces.some((t) => t.ref === selected)) {
      setSelected(traces[0]?.ref ?? null)
    }
  }, [traces, selected])

  useEffect(() => {
    if (selected === null) {
      setDetail(null)
      return
    }
    let live = true
    void window.reconix.traces
      .get(selected)
      .then((d) => {
        if (live) setDetail(d)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [selected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dock__panel" role="dialog" aria-label="Traces">
      <header className="settings__header">
        <h2 className="settings__title">Traces</h2>
        <button type="button" className="settings__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="traces__body">
        {traces.length === 0 ? (
          <p className="traces__empty">
            No traces yet. When the agent takes a screenshot or captures evidence, it appears
            here.
          </p>
        ) : (
          <>
            <ul className="traces__list">
              {traces.map((t) => (
                <li key={t.ref}>
                  <button
                    type="button"
                    className={`traces__row${t.ref === selected ? ' traces__row--active' : ''}`}
                    onClick={() => setSelected(t.ref)}
                  >
                    <span className={`traces__kind traces__kind--${t.kind}`}>
                      {KIND_LABEL[t.kind]}
                    </span>
                    <span className="traces__ref">{t.ref}</span>
                    <span className="traces__meta">
                      {formatBytes(t.bytes)} · {formatTime(t.ts)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="traces__preview">
              {detail === null ? (
                <p className="traces__empty">Loading…</p>
              ) : detail.kind === 'screenshot' ? (
                <img
                  className="traces__image"
                  src={`data:image/png;base64,${detail.data}`}
                  alt={`Screenshot ${detail.ref}`}
                />
              ) : (
                <pre className="traces__text">{detail.data}</pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default TracesPanel
