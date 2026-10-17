import type { ReactNode } from 'react'
import inspect from '../../assets/icons/inspect.svg'

export type DevToolsTab = 'elements' | 'network' | 'repeater' | 'console' | 'sources' | 'application'

const TABS: { id: DevToolsTab; label: string }[] = [
  { id: 'elements', label: 'Elements' },
  { id: 'network', label: 'Network' },
  { id: 'repeater', label: 'Repeater' },
  { id: 'console', label: 'Console' },
  { id: 'sources', label: 'Sources' },
  { id: 'application', label: 'Application' }
]

type DevToolsToolbarProps = {
  inspecting: boolean
  onToggleInspect: () => void
  activeTab: DevToolsTab
  onTabChange: (tab: DevToolsTab) => void
  /** Shown as "Label (n)" for tabs that accumulate items in the background (Network, Console). */
  counts?: Partial<Record<DevToolsTab, number>>
  /** Per-tab toolbar actions (e.g. Console's "Clear"), rendered at the trailing edge. */
  extra?: ReactNode
}

function DevToolsToolbar({
  inspecting,
  onToggleInspect,
  activeTab,
  onTabChange,
  counts,
  extra
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
      {TABS.map((tab) => {
        const count = counts?.[tab.id] ?? 0
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'dt-tab dt-tab--active' : 'dt-tab'}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
            {count > 0 ? ` (${count})` : ''}
          </button>
        )
      })}
      <span className="dt-toolbar__spacer" />
      {extra}
    </div>
  )
}

export default DevToolsToolbar
