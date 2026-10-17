import { useState } from 'react'
import CopilotPanel from './components/copilot/CopilotPanel'
import DevToolsPanel from './components/devtools/DevToolsPanel'
import Sidebar from './components/sidebar/Sidebar'
import ViewSlot from './components/ViewSlot'
import { useCopilot, type NodeRef } from './hooks/useCopilot'

const setTargetBounds = window.reconix.target.setBounds

function App(): JSX.Element {
  const copilot = useCopilot()
  const [draggedNode, setDraggedNode] = useState<NodeRef | null>(null)

  return (
    <div className="shell">
      <Sidebar />

      <main className="center">
        <section className="viewport" aria-label="Target page">
          <ViewSlot className="viewport__slot" onBoundsChange={setTargetBounds} />
        </section>
        <DevToolsPanel
          onNodeDragStart={setDraggedNode}
          onNodeDragEnd={() => setDraggedNode(null)}
        />
      </main>

      <CopilotPanel
        copilot={copilot}
        draggedNode={draggedNode}
        onNodeDrop={() => setDraggedNode(null)}
      />
    </div>
  )
}

export default App
