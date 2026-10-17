import { useEffect, useMemo, useState } from 'react'
import type { StyleRule } from '../../../../shared/devtools'
import type { NodeRef } from '../../hooks/useCopilot'
import { buildRows, useDomTree } from '../../hooks/useDomTree'
import Breadcrumbs from './Breadcrumbs'
import DevToolsToolbar from './DevToolsToolbar'
import ElementsTree from './ElementsTree'
import StylesPane from './StylesPane'

type DevToolsPanelProps = {
  onNodeDragStart: (node: NodeRef) => void
  onNodeDragEnd: () => void
}

function DevToolsPanel({ onNodeDragStart, onNodeDragEnd }: DevToolsPanelProps): JSX.Element {
  const { state, loaded, toggle, select } = useDomTree()
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const rows = useMemo(() => buildRows(state), [state])

  // page inspector turns itself off once element has been picked
  useEffect(
    () =>
      window.reconix.devtools.onEvent((event) => {
        if (event.method === 'Reconix.nodeInspected') setInspecting(false)
      }),
    []
  )

  useEffect(() => {
    const { selectedId } = state
    if (selectedId === null) {
      setRules(null)
      return
    }
    let stale = false
    void window.reconix.devtools.getStyles(selectedId).then((result) => {
      if (!stale) setRules(result)
    })
    return () => {
      stale = true
    }
  }, [state.selectedId, state.nodes.get(state.selectedId ?? -1)?.attrs])

  const toggleInspect = (): void => {
    const next = !inspecting
    setInspecting(next)
    void window.reconix.devtools.setInspectMode(next)
  }

  return (
    <section className="devtools" aria-label="Developer tools">
      <DevToolsToolbar inspecting={inspecting} onToggleInspect={toggleInspect} />
      <div className="dt-elements">
        <div className="dt-elements__tree">
          {loaded ? (
            <ElementsTree
              state={state}
              rows={rows}
              onSelect={select}
              onToggle={toggle}
              onHover={(id) => void window.reconix.devtools.highlight(id)}
              onNodeDragStart={onNodeDragStart}
              onNodeDragEnd={onNodeDragEnd}
            />
          ) : (
            <p className="dt-empty">Inspector unavailable.</p>
          )}
          <Breadcrumbs state={state} />
        </div>
        <StylesPane rules={rules} />
      </div>
    </section>
  )
}

export default DevToolsPanel
