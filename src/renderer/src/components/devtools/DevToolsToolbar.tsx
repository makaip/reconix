import inspect from '../../assets/icons/inspect.svg'

export type DevToolsTab = 'elements' | 'network'

type DevToolsToolbarProps = {
  inspecting: boolean
  onToggleInspect: () => void
  activeTab: DevToolsTab
  onTabChange: (tab: DevToolsTab) => void
  networkCount: number
}

function DevToolsToolbar({
  inspecting,
  onToggleInspect,
  activeTab,
  onTabChange,
  networkCount
}: DevToolsToolbarProps): JSX.Element {
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
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'elements'}
        className={activeTab === 'elements' ? 'dt-tab dt-tab--active' : 'dt-tab'}
        onClick={() => onTabChange('elements')}
      >
        Elements
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'network'}
        className={activeTab === 'network' ? 'dt-tab dt-tab--active' : 'dt-tab'}
        onClick={() => onTabChange('network')}
      >
        Network{networkCount > 0 ? ` (${networkCount})` : ''}
      </button>
      <span className="dt-toolbar__spacer" />
    </div>
  )
}

export default DevToolsToolbar
