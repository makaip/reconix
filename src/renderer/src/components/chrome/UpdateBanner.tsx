type UpdateBannerProps = {
  version: string
  onRestart: () => void
}

/**
 * Sits in the document flow (like EngineStatusBanner) rather than floating: the
 * target page is a native view that paints above this window's HTML, so a
 * positioned overlay would be hidden behind it.
 */
function UpdateBanner({ version, onRestart }: UpdateBannerProps): JSX.Element {
  return (
    <div className="update-banner" role="status">
      <span>Reconix {version} is ready to install.</span>
      <button type="button" className="update-banner__action" onClick={onRestart}>
        Restart now
      </button>
    </div>
  )
}

export default UpdateBanner
