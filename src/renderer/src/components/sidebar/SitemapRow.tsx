import fileMuted from '../../assets/icons/file-muted.svg'
import { RESOURCE_DRAG_TYPE, type ResourceDragItem } from '../../lib/dragTypes'
import type { SitemapNode } from '../../lib/sitemap'

type SitemapRowProps = {
  node: SitemapNode
  selected: boolean
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
  onSelect,
  onOpen,
  dragItems,
  onDragStart,
  onDragEnd
}: SitemapRowProps): JSX.Element {
  return (
    <button
      type="button"
      className={[
        'sitemap-row',
        node.kind === 'folder' && 'sitemap-row--folder',
        selected && 'sitemap-row--selected'
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ paddingLeft: 10 + node.depth * 14 }}
      aria-current={selected ? 'true' : undefined}
      draggable={node.kind === 'page'}
      onClick={(event) =>
        onSelect(node.id, {
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey
        })
      }
      onDoubleClick={onOpen}
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
      <img src={fileMuted} width={13} height={13} alt="" />
      <span className="sitemap-row__label">{node.label}</span>
    </button>
  )
}

export default SitemapRow
