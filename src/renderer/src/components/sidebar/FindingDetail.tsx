import { useEffect, useMemo, useState } from 'react'
import type { Finding, FindingStatus, FindingTriagePatch } from '../../../../shared/findings'

const STATUS_OPTIONS: { value: FindingStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'false-positive', label: 'False positive' },
  { value: 'fixed', label: 'Fixed' }
]

type FindingDetailProps = {
  finding: Finding
  onSave: (id: string, patch: FindingTriagePatch) => Promise<boolean>
  onClose: () => void
}

/** Parse the CVSS input: '' clears the score, anything outside 0..10 is invalid. */
function parseCvss(raw: string): { value: number | null; valid: boolean } {
  const trimmed = raw.trim()
  if (trimmed === '') return { value: null, valid: true }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0 || value > 10) return { value: null, valid: false }
  return { value, valid: true }
}

function FindingDetail({ finding, onSave, onClose }: FindingDetailProps): JSX.Element {
  const [status, setStatus] = useState<FindingStatus>(finding.status ?? 'open')
  const [cvss, setCvss] = useState(finding.cvss === undefined ? '' : String(finding.cvss))
  const [notes, setNotes] = useState(finding.notes ?? '')
  const [saving, setSaving] = useState(false)

  // The panel stays mounted while the broadcast pushes new finding objects, so
  // reset the drafts only when the analyst switches to a different finding.
  const findingId = finding.id
  useEffect(() => {
    setStatus(finding.status ?? 'open')
    setCvss(finding.cvss === undefined ? '' : String(finding.cvss))
    setNotes(finding.notes ?? '')
    setSaving(false)
  }, [findingId])

  // Esc closes, matching SettingsModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const parsed = useMemo(() => parseCvss(cvss), [cvss])

  const save = async (): Promise<void> => {
    if (!parsed.valid || saving) return
    const patch: FindingTriagePatch = { status }
    // Empty notes / cvss go through as null so the column is cleared rather than
    // stored as an empty string.
    patch.notes = notes.trim() === '' ? null : notes
    patch.cvss = parsed.value
    setSaving(true)
    try {
      await onSave(finding.id, patch)
    } finally {
      setSaving(false)
      onClose()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal finding-detail"
        role="dialog"
        aria-modal="true"
        aria-label="Finding detail"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="finding-detail__header">
          <span className={`finding-card__severity finding-card__severity--${finding.severity}`}>
            {finding.severity}
          </span>
          <h2 className="finding-detail__title" title={finding.title}>
            {finding.title}
          </h2>
          <button type="button" className="finding-detail__close" aria-label="Close finding detail" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="finding-detail__body">
          <label className="finding-detail__field">
            <span className="finding-detail__label">Status</span>
            <select
              className="finding-detail__input"
              value={status}
              onChange={(e) => setStatus(e.target.value as FindingStatus)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="finding-detail__field">
            <span className="finding-detail__label">CVSS</span>
            <input
              className="finding-detail__input"
              type="number"
              min={0}
              max={10}
              step={0.1}
              placeholder="0.0 – 10.0"
              value={cvss}
              aria-invalid={!parsed.valid}
              onChange={(e) => setCvss(e.target.value)}
            />
            {!parsed.valid && <span className="finding-detail__error">Score must be between 0 and 10.</span>}
          </label>

          <label className="finding-detail__field finding-detail__field--notes">
            <span className="finding-detail__label">Notes</span>
            <textarea
              className="finding-detail__input finding-detail__notes"
              rows={6}
              placeholder="Triage notes…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
        </div>

        <footer className="finding-detail__footer">
          <button type="button" className="finding-detail__btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="finding-detail__btn finding-detail__btn--primary"
            disabled={!parsed.valid || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default FindingDetail
