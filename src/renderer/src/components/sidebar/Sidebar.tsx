import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import plus from '../../assets/icons/plus.svg'
import { useFindings } from '../../hooks/useFindings'
import { useEngagement } from '../../hooks/useEngagement'
import { useSitemap } from '../../hooks/useSitemap'
import type { ResourceDragItem } from '../../lib/dragTypes'
import { nextSelection, type SelectMods } from '../../lib/selection'
import type { SitemapNode } from '../../lib/sitemap'
import { firstChildIndex, parentIndex, verticalTarget } from '../../lib/treeNav'
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
  const findings = useFindings()
  const engagement = useEngagement()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** The keyboard cursor row (VS Code's "focused" item), independent of the selection. */
  const [focus, setFocus] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

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

  const select = (id: string, mods: SelectMods): void => {
    const result = nextSelection(selected, anchor, id, visible.map((n) => n.id), mods)
    setSelected(result.set)
    setAnchor(result.anchor)
    setFocus(id)
  }

  // A clicked row hands focus to the tree so arrow keys work (and Enter/Space don't re-click the button).
  const clickSelect = (id: string, mods: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void => {
    select(id, mods)
    treeRef.current?.focus({ preventScroll: true })
  }

  // If the cursor row got hidden by collapsing an ancestor, fall back to its nearest visible ancestor.
  let focusIndex = -1
  if (focus !== null) {
    let id = focus
    while ((focusIndex = visible.findIndex((n) => n.id === id)) === -1 && id.includes('/')) {
      id = id.slice(0, id.lastIndexOf('/'))
    }
  }
  const focusNode = focusIndex >= 0 ? visible[focusIndex] : null

  // Keyed on the id, not the node, so sitemap rebuilds from new traffic don't yank the scroll.
  const focusId = focusNode?.id
  useEffect(() => {
    if (!focusId) return
    treeRef.current
      ?.querySelector(`[data-id="${CSS.escape(focusId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focusId])

  /** Moves the cursor to `index`: shift extends the range, cmd/ctrl moves without selecting, plain selects. */
  const moveTo = (index: number, event: KeyboardEvent): void => {
    const id = visible[index].id
    if (event.shiftKey) {
      // First shift-move with no anchor ranges from where the cursor was.
      const from = anchor ?? focusNode?.id ?? id
      const result = nextSelection(selected, from, id, visible.map((n) => n.id), { shiftKey: true })
      setSelected(result.set)
      setAnchor(result.anchor)
      setFocus(id)
    } else if (event.metaKey || event.ctrlKey) {
      setFocus(id)
    } else {
      select(id, {})
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const vertical = verticalTarget(event.key, focusIndex, visible.length)
    if (vertical !== null) {
      handled()
      moveTo(vertical, event)
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      handled()
      setSelected(new Set(visible.map((n) => n.id)))
      return
    }
    if (event.key === 'Escape') {
      handled()
      setSelected(new Set())
      setAnchor(null)
      return
    }
    if (!focusNode) return
    const isFolder = focusNode.kind === 'folder'
    const isCollapsed = collapsed.has(focusNode.id)
    switch (event.key) {
      case 'ArrowRight': {
        handled()
        if (!isFolder) return
        if (isCollapsed) toggle(focusNode.id)
        else {
          const child = firstChildIndex(visible, focusIndex)
          if (child !== -1) moveTo(child, event)
        }
        return
      }
      case 'ArrowLeft': {
        handled()
        if (isFolder && !isCollapsed) toggle(focusNode.id)
        else {
          const parent = parentIndex(visible, focusIndex)
          if (parent !== -1) moveTo(parent, event)
        }
        return
      }
      case 'Enter':
        handled()
        if (isFolder) toggle(focusNode.id)
        else onOpenSource(focusNode.id)
        return
      case ' ':
        handled()
        select(focusNode.id, { metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey })
        return
    }
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
          <div
            ref={treeRef}
            className="sitemap"
            role="tree"
            aria-label="Sitemap"
            aria-multiselectable="true"
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            <div className="sitemap__rows">
              {visible.map((node) => (
                <SitemapRow
                  key={node.id}
                  node={node}
                  selected={selected.has(node.id)}
                  focused={node === focusNode}
                  collapsed={collapsed.has(node.id)}
                  onToggle={() => toggle(node.id)}
                  onSelect={clickSelect}
                  onOpen={() => node.kind === 'page' && onOpenSource(node.id)}
                  dragItems={() => dragItems(node.id)}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              ))}
            </div>
          </div>
        )}

        <SectionHeader label="Findings" count={findings.length} />
        {findings.length === 0 ? (
          <p className="dt-empty">No findings yet.</p>
        ) : (
          findings.map((finding) => <FindingCard key={finding.id} finding={finding} />)
        )}
      </div>

      <div className="sidebar__engagement">
        <SectionHeader label="Engagement" count={engagement.current ? 1 : 0} />
        {engagement.current ? (
          <>
            <p className="sidebar__engagement-status">
              Running: <code>{engagement.current.id}</code>
            </p>
            <p className="sidebar__engagement-goal">{engagement.current.goal}</p>
            <button type="button" className="sidebar__engagement-btn" onClick={() => void engagement.stop()}>
              Stop engagement
            </button>
          </>
        ) : (
          <button
            type="button"
            className="sidebar__engagement-btn"
            onClick={() => {
              const goal = window.prompt('Engagement goal…')
              if (goal && goal.trim()) void engagement.start(goal.trim())
            }}
          >
            Start engagement
          </button>
        )}
      </div>

      <button type="button" className="add-note">
        <img src={plus} width={13} height={13} alt="" />
        <span>Add note to engagement</span>
      </button>
    </aside>
  )
}

export default Sidebar
