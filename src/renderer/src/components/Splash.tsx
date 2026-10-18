const MOD = window.reconix.platform === 'darwin' ? '⌘' : 'Ctrl+'
const SHIFT = window.reconix.platform === 'darwin' ? '⇧' : 'Shift+'

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: `${MOD}T`, label: 'New tab' },
  { keys: `${SHIFT}${MOD}T`, label: 'Reopen closed tab' },
  { keys: `${MOD}W`, label: 'Close tab' },
  { keys: 'Ctrl+Tab', label: 'Next tab' }
]

const STEPS: { title: string; body: string }[] = [
  { title: 'Browse the target', body: 'Enter an in-scope URL in the address bar.' },
  { title: 'Watch the traffic', body: 'Requests, responses and WebSockets are captured in DevTools.' },
  { title: 'Ask Copilot', body: 'Drag requests or files into Copilot to analyze them.' }
]

/** New-tab page, shown in the page area while the active tab has no site loaded. */
function Splash(): JSX.Element {
  return (
    <div className="splash">
      <div className="splash__content">
        <h1 className="splash__title">Welcome to Reconix</h1>
        <p className="splash__subtitle">Enter a URL in the address bar to get started.</p>

        <ol className="splash__steps">
          {STEPS.map((step) => (
            <li key={step.title} className="splash__step">
              <span className="splash__step-title">{step.title}</span>
              <span className="splash__step-body">{step.body}</span>
            </li>
          ))}
        </ol>

        <dl className="splash__shortcuts">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.label} className="splash__shortcut">
              <dt>{shortcut.label}</dt>
              <dd>
                <kbd>{shortcut.keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>

        <p className="splash__notice">Only test systems you are authorized to test.</p>
      </div>
    </div>
  )
}

export default Splash
