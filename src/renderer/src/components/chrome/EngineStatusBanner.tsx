import type { EngineStatus } from '../../../../shared/contracts'

function EngineStatusBanner({ status }: { status: EngineStatus }): JSX.Element | null {
  if (status.status === 'ready') return null

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
