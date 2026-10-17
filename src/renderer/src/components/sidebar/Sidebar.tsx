import { useMemo, useState, type CSSProperties } from 'react'
import plus from '../../assets/icons/plus.svg'
import { findings } from '../../mock/data'
import { useSitemap } from '../../hooks/useSitemap'
import type { ResourceDragItem } from '../../lib/dragTypes'
import { nextSelection } from '../../lib/selection'
import type { SitemapNode } from '../../lib/sitemap'
import FindingCard from './FindingCard'
import SectionHeader from './SectionHeader'
import SitemapRow from './SitemapRow'

type SidebarProps = {
  style?: CSSProperties
  onDragStart: () => void
  onDragEnd: () => void
  /** Open a sitemap endpoint in the DevTools Sources tab. */
  onOpenSource: (target: string) => void
}

/** The payload a sitemap node contributes to a drag/attach: its host+path is both url and label. */
const toDragItem = (node: SitemapNode): ResourceDragItem => ({ url: node.id, label: node.id })

function Sidebar({ style, onDragStart, onDragEnd, onOpenSource }: SidebarProps): JSX.Element {
  const sitemap = useSitemap()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  // Rows under a collapsed folder are hidden; nodes are in tree order so a depth cutoff suffices.
  const visible = useMemo(() => {
    const out: SitemapNode[] = []
    let hideBelow = Infinity
    for (const node of sitemap) {
      if (node.depth > hideBelow) continue
      hideBelow = node.kind === 'folder' && collapsed.has(node.id) ? node.depth : Infinity
      out.push(node)
    }
    return out
  }, [sitemap, collapsed])

  const toggle = (id: string): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const select = (id: string, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void => {
    const result = nextSelection(selected, anchor, id, visible.map((n) => n.id), mods)
    setSelected(result.set)
    setAnchor(result.anchor)
  }

  // Dragging a row carries every selected node; dragging an unselected row selects just it first.
  const dragItems = (id: string): ResourceDragItem[] => {
    const ids = selected.has(id) ? selected : new Set([id])
    if (!selected.has(id)) {
      setSelected(ids)
      setAnchor(id)
    }
    return sitemap.filter((n) => ids.has(n.id) && n.kind === 'page').map(toDragItem)
  }

  return (
    <aside className="sidebar" aria-label="Sitemap and findings" style={style}>
      <div className="sidebar__scroll">
        <SectionHeader label="Sitemap" count={sitemap.length} />
        {sitemap.length === 0 ? (
          <p className="dt-empty">No requests captured yet.</p>
        ) : (
          visible.map((node) => (
            <SitemapRow
              key={node.id}
              node={node}
              selected={selected.has(node.id)}
              collapsed={collapsed.has(node.id)}
              onToggle={() => toggle(node.id)}
              onSelect={select}
              onOpen={() => node.kind === 'page' && onOpenSource(node.id)}
              dragItems={() => dragItems(node.id)}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))
        )}

        <SectionHeader label="Findings" count={findings.length} />
        {findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} />
        ))}
      </div>

      <button type="button" className="add-note">
        <img src={plus} width={13} height={13} alt="" />
        <span>Add note to engagement</span>
      </button>
    </aside>
  )
}

export default Sidebar
