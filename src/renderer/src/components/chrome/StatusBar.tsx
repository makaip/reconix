import { proxy, scope } from '../../mock/data'

function StatusBar({ requests }: { requests: number }): JSX.Element {
  return (
    <footer className="statusbar">
      {/* proxy, scope and copilot status are placeholders until those features exist */}
      <span className="statusbar__ok">● Proxy {proxy.address}</span>
      <span>Scope: {scope.summary}</span>
      <span>Requests: {requests}</span>
      <span className="statusbar__spacer" />
      <span className="statusbar__strong">Copilot: ready, read-only</span>
    </footer>
  )
}

export default StatusBar
