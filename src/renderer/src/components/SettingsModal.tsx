import { useEffect } from 'react'
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

  // Esc closes, matching the native-feel of the rest of the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dock__panel" role="dialog" aria-label="Settings">
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
      </div>
    </div>
  )
}

export default SettingsModal
