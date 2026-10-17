import { useState, type DragEvent, type KeyboardEvent } from 'react'
import type { TabInfo } from '../../../../shared/tabs'
import tabClose from '../../assets/icons/tab-close.svg'
import tabGlobe from '../../assets/icons/tab-globe.svg'
import tabPlus from '../../assets/icons/tab-plus.svg'
import { TAB_DRAG_TYPE } from '../../lib/dragTypes'

type TabBarProps = {
  tabs: TabInfo[]
  activeId: number | null
  onActivate: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
  /** Moves a tab so it ends up at `toIndex`. */
  onMove: (id: number, toIndex: number) => void
}

// where a dragged tab would land: before or after the hovered tab
type DropTarget = { id: number; after: boolean }

function tabTitle(tab: TabInfo): string {
  if (tab.title) return tab.title
  try {
    return new URL(tab.url).host || 'New Tab'
  } catch {
    return 'New Tab'
  }
}

function TabBar({ tabs, activeId, onActivate, onClose, onNew, onMove }: TabBarProps): JSX.Element {
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  const endDrag = (): void => {
    setDraggingId(null)
    setDropTarget(null)
  }

  const dragOver = (event: DragEvent, id: number): void => {
    if (draggingId === null || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const box = event.currentTarget.getBoundingClientRect()
    const after = event.clientX > box.left + box.width / 2
    if (dropTarget?.id !== id || dropTarget.after !== after) setDropTarget({ id, after })
  }

  const drop = (event: DragEvent): void => {
    event.preventDefault()
    if (draggingId !== null && dropTarget) {
      const from = tabs.findIndex((tab) => tab.id === draggingId)
      let to = tabs.findIndex((tab) => tab.id === dropTarget.id) + (dropTarget.after ? 1 : 0)
      // the dragged tab leaves its old slot first, shifting later slots left by one
      if (to > from) to -= 1
      if (to !== from) onMove(draggingId, to)
    }
    endDrag()
  }

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
        const className = [
          'tab',
          active && 'tab--active',
          tab.id === draggingId && 'tab--dragging',
          dropTarget?.id === tab.id && tab.id !== draggingId && (dropTarget.after ? 'tab--drop-after' : 'tab--drop-before')
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={className}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData(TAB_DRAG_TYPE, String(tab.id))
              setDraggingId(tab.id)
            }}
            onDragOver={(event) => dragOver(event, tab.id)}
            onDrop={drop}
            onDragEnd={endDrag}
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
