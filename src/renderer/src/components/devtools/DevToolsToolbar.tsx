import inspect from '../../assets/icons/inspect.svg'

type DevToolsToolbarProps = {
  inspecting: boolean
  onToggleInspect: () => void
}

function DevToolsToolbar({ inspecting, onToggleInspect }: DevToolsToolbarProps): JSX.Element {
  return (
    <div className="dt-toolbar" role="tablist">
      <button
        type="button"
        className={inspecting ? 'dt-icon-button dt-icon-button--active' : 'dt-icon-button'}
        aria-label="Select an element in the page"
        aria-pressed={inspecting}
        onClick={onToggleInspect}
      >
        <img src={inspect} width={15} height={15} alt="" />
      </button>
      <span className="dt-toolbar__divider" />
      <button type="button" role="tab" aria-selected className="dt-tab dt-tab--active">
        Elements
      </button>
      <span className="dt-toolbar__spacer" />
    </div>
  )
}

export default DevToolsToolbar
