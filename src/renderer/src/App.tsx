import { useState } from 'react'
import CopilotPanel from './components/copilot/CopilotPanel'
import DevToolsPanel from './components/devtools/DevToolsPanel'
import Sidebar from './components/sidebar/Sidebar'
import ViewSlot from './components/ViewSlot'
import StatusBar from './components/chrome/StatusBar'
import TabBar from './components/chrome/TabBar'
import Toolbar from './components/chrome/Toolbar'
import { useCopilot, type NodeRef } from './hooks/useCopilot'
import { useNetworkStats } from './hooks/useNetworkStats'
import { useTabs } from './hooks/useTabs'

const setTargetBounds = window.reconix.target.setBounds

function App(): JSX.Element {
  const copilot = useCopilot()
  const tabs = useTabs()
  const network = useNetworkStats()
  const [draggedNode, setDraggedNode] = useState<NodeRef | null>(null)
  const [copilotOpen, setCopilotOpen] = useState(true)

  const activeTab = tabs.tabs.find((tab) => tab.id === tabs.activeId)
  const requestCount = tabs.activeId === null ? 0 : (network.perTab[tabs.activeId] ?? 0)

  return (
    <div className="app">
      <TabBar
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        onActivate={(id) => void window.reconix.tabs.activate(id)}
        onClose={(id) => void window.reconix.tabs.close(id)}
        onNew={() => void window.reconix.tabs.create()}
      />
      <Toolbar
        url={activeTab?.url ?? ''}
        canGoBack={tabs.canGoBack}
        canGoForward={tabs.canGoForward}
        copilotOpen={copilotOpen}
        onToggleCopilot={() => setCopilotOpen((open) => !open)}
      />

      <div className="shell">
        <Sidebar />

        <main className="center">
          <section className="viewport" aria-label="Target page">
            <ViewSlot className="viewport__slot" onBoundsChange={setTargetBounds} />
          </section>
          <DevToolsPanel
            activeTabId={tabs.activeId}
            onNodeDragStart={setDraggedNode}
            onNodeDragEnd={() => setDraggedNode(null)}
          />
        </main>

        {copilotOpen && (
          <CopilotPanel
            copilot={copilot}
            draggedNode={draggedNode}
            onNodeDrop={() => setDraggedNode(null)}
            onClose={() => setCopilotOpen(false)}
            requestCount={requestCount}
          />
        )}
      </div>

      <StatusBar requests={network.total} />
    </div>
  )
}

export default App
