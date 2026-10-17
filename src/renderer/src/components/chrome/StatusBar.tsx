import { proxy, scope } from '../../mock/data'

function StatusBar({ requests }: { requests: number }): JSX.Element {
  return (
    <footer className="statusbar">
      {/* proxy, scope and copilot status are placeholders until those features exist */}
      <span className="statusbar__item">Proxy {proxy.address}</span>
      <span className="statusbar__item">Scope: {scope.summary}</span>
      <span className="statusbar__item">Requests: {requests}</span>
      <span className="statusbar__spacer" />
      <span className="statusbar__item statusbar__item--end">Copilot: ready, read-only</span>
    </footer>
  )
}

export default StatusBar
