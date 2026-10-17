import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { StyleRule } from '../../../../shared/devtools'
import type { NodeRef } from '../../hooks/useCopilot'
import { buildRows, useDomTree } from '../../hooks/useDomTree'
import { useNetworkRequests } from '../../hooks/useNetworkRequests'
import Breadcrumbs from './Breadcrumbs'
import DevToolsToolbar, { type DevToolsTab } from './DevToolsToolbar'
import ElementsTree from './ElementsTree'
import NetworkPanel from './NetworkPanel'
import StylesPane from './StylesPane'

type DevToolsPanelProps = {
  /** Changes when the user switches tabs; the page inspector doesn't carry over. */
  activeTabId: number | null
  onNodeDragStart: (node: NodeRef) => void
  onNodeDragEnd: () => void
  style?: CSSProperties
}

function DevToolsPanel({
  activeTabId,
  onNodeDragStart,
  onNodeDragEnd,
  style
}: DevToolsPanelProps): JSX.Element {
  const { state, loaded, toggle, select } = useDomTree()
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [devtoolsTab, setDevtoolsTab] = useState<DevToolsTab>('elements')
  const rows = useMemo(() => buildRows(state), [state])
  const networkRequests = useNetworkRequests(activeTabId)

  useEffect(() => setInspecting(false), [activeTabId])

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
    <section className="devtools" aria-label="Developer tools" style={style}>
      <DevToolsToolbar
        inspecting={inspecting}
        onToggleInspect={toggleInspect}
        activeTab={devtoolsTab}
        onTabChange={setDevtoolsTab}
        networkCount={networkRequests.length}
      />
      {devtoolsTab === 'elements' ? (
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
      ) : (
        <NetworkPanel requests={networkRequests} />
      )}
    </section>
  )
}

export default DevToolsPanel
