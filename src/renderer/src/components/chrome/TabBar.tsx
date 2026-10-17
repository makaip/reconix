import type { KeyboardEvent } from 'react'
import type { TabInfo } from '../../../../shared/tabs'
import tabClose from '../../assets/icons/tab-close.svg'
import tabGlobe from '../../assets/icons/tab-globe.svg'
import tabPlus from '../../assets/icons/tab-plus.svg'

type TabBarProps = {
  tabs: TabInfo[]
  activeId: number | null
  onActivate: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
}

function tabTitle(tab: TabInfo): string {
  if (tab.title) return tab.title
  try {
    return new URL(tab.url).host || 'New Tab'
  } catch {
    return 'New Tab'
  }
}

function TabBar({ tabs, activeId, onActivate, onClose, onNew }: TabBarProps): JSX.Element {
  const activateOnKey = (event: KeyboardEvent, id: number): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onActivate(id)
    }
  }

  return (
    <div className="tabbar" role="tablist" aria-label="Browser tabs">
      {tabs.map((tab) => {
        const title = tabTitle(tab)
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={active ? 'tab tab--active' : 'tab'}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => activateOnKey(event, tab.id)}
            onAuxClick={(event) => {
              if (event.button === 1) onClose(tab.id)
            }}
          >
            <img src={tabGlobe} width={14} height={14} alt="" />
            <span className="tab__title">{title}</span>
            <button
              type="button"
              className="icon-button tab__close"
              aria-label={`Close ${title}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              <img src={tabClose} width={12} height={12} alt="" />
            </button>
          </div>
        )
      })}
      <button type="button" className="icon-button tabbar__new" aria-label="New tab" onClick={onNew}>
        <img src={tabPlus} width={14} height={14} alt="" />
      </button>
    </div>
  )
}

export default TabBar
