import type { EngineStatus } from '../../../../shared/contracts'

function EngineStatusBanner({ status }: { status: EngineStatus }): JSX.Element | null {
  if (status.status === 'ready') return null

  // Booted fine, but the model backend isn't answering — recoverable, so the
  // engine keeps probing and this clears itself once the backend is back.
  if (status.status === 'offline') {
    return (
      <div className="engine-banner engine-banner--offline">
        <span>
          Copilot backend is offline — the model isn&rsquo;t responding. Browsing still works; retrying
          automatically…
        </span>
      </div>
    )
  }

  return (
    <div className={status.status === 'error' ? 'engine-banner engine-banner--error' : 'engine-banner'}>
      {status.status === 'starting' ? (
        <>
          <span className="engine-banner__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>Starting AI engine — navigation is paused until it&rsquo;s ready…</span>
        </>
      ) : (
        <span>AI engine failed to start ({status.error}) — browsing works, but Copilot won&rsquo;t.</span>
      )}
    </div>
  )
}

export default EngineStatusBanner
