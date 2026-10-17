import ViewSlot from './components/ViewSlot'

function App(): JSX.Element {
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Sitemap and findings" />

      <main className="center">
        <section className="viewport" aria-label="Target page">
          <ViewSlot view="page" className="viewport__slot" />
        </section>
        <section className="devtools" aria-label="Developer tools">
          <ViewSlot view="devtools" className="devtools__slot" />
        </section>
      </main>

      <aside className="copilot" aria-label="Copilot" />
    </div>
  )
}

export default App
