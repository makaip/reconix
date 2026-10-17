import chevron from '../../assets/icons/chevron-right.svg'
import tabGlobe from '../../assets/icons/tab-globe.svg'
import { RESOURCE_DRAG_TYPE, type ResourceDragItem } from '../../lib/dragTypes'
import { fileIcon, folderIcon } from '../../lib/fileIcon'
import type { SitemapNode } from '../../lib/sitemap'

type SitemapRowProps = {
  node: SitemapNode
  selected: boolean
  /** The keyboard cursor is on this row. */
  focused: boolean
  /** Folder rows only: whether its children are hidden. */
  collapsed: boolean
  onToggle: () => void
  onSelect: (id: string, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void
  /** Double-click: open the endpoint in the Sources tab. */
  onOpen: () => void
  /** The files this drag carries (the current selection, or just this row). */
  dragItems: () => ResourceDragItem[]
  onDragStart: () => void
  onDragEnd: () => void
}

function SitemapRow({
  node,
  selected,
  focused,
  collapsed,
  onToggle,
  onSelect,
  onOpen,
  dragItems,
  onDragStart,
  onDragEnd
}: SitemapRowProps): JSX.Element {
  const isFolder = node.kind === 'folder'
  const icon = node.depth === 0 ? tabGlobe : isFolder ? folderIcon(!collapsed) : fileIcon(node.label)

  return (
    <button
      type="button"
      className={[
        'sitemap-row',
        isFolder && 'sitemap-row--folder',
        selected && 'sitemap-row--selected',
        focused && 'sitemap-row--focused'
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ paddingLeft: 10 + node.depth * 14 }}
      aria-current={selected ? 'true' : undefined}
      aria-expanded={isFolder ? !collapsed : undefined}
      title={node.id}
      data-id={node.id}
      tabIndex={-1}
      draggable={node.kind === 'page'}
      onClick={(event) =>
        onSelect(node.id, {
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey
        })
      }
      onDoubleClick={isFolder ? onToggle : onOpen}
      onDragStart={(event) => {
        const items = dragItems()
        if (items.length === 0) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData(RESOURCE_DRAG_TYPE, JSON.stringify(items))
        event.dataTransfer.setData('text/plain', items.map((item) => item.url).join('\n'))
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      <span
        className={[
          'sitemap-row__toggle',
          !isFolder && 'sitemap-row__toggle--none',
          isFolder && !collapsed && 'sitemap-row__toggle--open'
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden="true"
        onClick={(event) => {
          if (!isFolder) return
          event.stopPropagation()
          onToggle()
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <img src={chevron} width={12} height={12} alt="" />
      </span>
      <img src={icon} width={14} height={14} alt="" />
      <span className="sitemap-row__label">{node.label}</span>
    </button>
  )
}

export default SitemapRow
