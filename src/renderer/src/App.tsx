import CopilotPanel from './components/copilot/CopilotPanel'
import DevToolsPanel from './components/devtools/DevToolsPanel'
import Sidebar from './components/sidebar/Sidebar'
import ViewSlot from './components/ViewSlot'

const setTargetBounds = window.reconix.target.setBounds

function App(): JSX.Element {
  return (
    <div className="shell">
      <Sidebar />

      <main className="center">
        <section className="viewport" aria-label="Target page">
          <ViewSlot className="viewport__slot" onBoundsChange={setTargetBounds} />
        </section>
        <DevToolsPanel />
      </main>

      <CopilotPanel />
    </div>
  )
}

export default App
