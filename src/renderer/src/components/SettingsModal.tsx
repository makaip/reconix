import { useEffect, useState } from 'react'
import type { UseSettings } from '../hooks/useSettings'

type SettingsModalProps = {
  settings: UseSettings
  onClose: () => void
}

type ToggleRowProps = {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}

function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps): JSX.Element {
  return (
    <label className="settings__row">
      <span className="settings__row-text">
        <span className="settings__row-label">{label}</span>
        {hint && <span className="settings__row-hint">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function SettingsModal({ settings, onClose }: SettingsModalProps): JSX.Element {
  const { settings: values, set } = settings

  // About / Updates: version comes from main (window.reconix.app.version), and
  // the check is a plain IPC round-trip that never throws — failures come back
  // as { ok: false, error } and are shown inline.
  const version = window.reconix.app?.version || 'unknown'
  const [checking, setChecking] = useState(false)
  const [updateStatus, setUpdateStatus] = useState('')

  const onCheckForUpdates = async (): Promise<void> => {
    setChecking(true)
    setUpdateStatus('Checking for updates…')
    const result = await window.reconix.app.checkForUpdates()
    setChecking(false)
    if (!result.ok) {
      setUpdateStatus(`Update check failed: ${result.error ?? 'unknown error'}`)
    } else if (result.version) {
      setUpdateStatus(`Version ${result.version} is downloading in the background.`)
    } else {
      setUpdateStatus('You’re on the latest version.')
    }
  }

  // Esc closes, matching the native-feel of the rest of the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="settings__header">
        <h2 className="settings__title">Settings</h2>
        <button type="button" className="settings__close" aria-label="Close settings" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="settings__body">
        <section className="settings__section">
          <h3 className="settings__section-title">General</h3>
          <ToggleRow
            label="Open sitemap on launch"
            hint="Show the sidebar when the app starts"
            checked={values.openSidebarOnLaunch}
            onChange={(v) => set('openSidebarOnLaunch', v)}
          />
          <ToggleRow
            label="Open Copilot on launch"
            hint="Show the Copilot panel when the app starts"
            checked={values.openCopilotOnLaunch}
            onChange={(v) => set('openCopilotOnLaunch', v)}
          />
        </section>

        <section className="settings__section">
          <h3 className="settings__section-title">About</h3>
          <div className="settings__row">
            <span className="settings__row-text">
              <span className="settings__row-label">Reconix {version}</span>
              {updateStatus && <span className="settings__row-hint">{updateStatus}</span>}
            </span>
            <button
              type="button"
              className="settings__button"
              onClick={() => void onCheckForUpdates()}
              disabled={checking}
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
        </section>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
