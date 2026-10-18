import type { TurnUsage, UsageSnapshot } from '../../../../shared/contracts'
import { proxy, scope } from '../../mock/data'

type StatusBarProps = {
  requests: number
  usage: UsageSnapshot
  onOpenUsage: () => void
}

function latestTurn(usage: UsageSnapshot): TurnUsage | undefined {
  return usage.activeTurns[usage.activeTurns.length - 1] ?? usage.turns[usage.turns.length - 1]
}

function ttftMs(turn: TurnUsage): number | null {
  return turn.firstTokenAt === undefined ? null : Math.max(0, turn.firstTokenAt - turn.startedAt)
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function StatusBar({ requests, usage, onOpenUsage }: StatusBarProps): JSX.Element {
  const active = usage.activeTurns.length > 0
  const turn = latestTurn(usage)

  return (
    <footer className="statusbar">
      {/* proxy and scope are placeholders until those features exist */}
      <span className="statusbar__item">Proxy {proxy.address}</span>
      <span className="statusbar__item">Scope: {scope.summary}</span>
      <span className="statusbar__item">Requests: {requests}</span>
      <span className="statusbar__spacer" />
      <button
        type="button"
        className="statusbar__button"
        onClick={onOpenUsage}
        title="Open cost & latency details"
      >
        {active && <span className="statusbar__dot" aria-hidden="true" />}
        Latency
        {turn && ` · TTFT ${formatMs(ttftMs(turn))}`}
        {turn?.finishedAt !== undefined && ` · ${formatMs(turn.finishedAt - turn.startedAt)}`}
      </button>
      <span className="statusbar__item statusbar__item--end">Copilot: ready, read-only</span>
    </footer>
  )
}

export default StatusBar
