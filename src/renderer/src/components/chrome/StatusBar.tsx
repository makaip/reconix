import type { TurnUsage, UsageSnapshot } from '../../../../shared/contracts'
import { useScope } from '../../hooks/useScope'
import { proxy } from '../../mock/data'

type StatusBarProps = {
  requests: number
  usage: UsageSnapshot
  onOpenUsage: () => void
}

/** A background call (DOM-parser refresh) — no session, so no TTFT/agent model. */
const isAmbient = (turn: TurnUsage): boolean => turn.sessionId === ''

/**
 * The most recent real agent turn. Background DOM-parser refreshes are excluded:
 * they fire on every navigation, so letting them win here would hide the
 * assistant's latency the moment the user browses.
 */
function latestAgentTurn(usage: UsageSnapshot): TurnUsage | undefined {
  const active = usage.activeTurns.filter((turn) => !isAmbient(turn))
  if (active.length > 0) return active[active.length - 1]
  for (let i = usage.turns.length - 1; i >= 0; i -= 1) {
    if (!isAmbient(usage.turns[i])) return usage.turns[i]
  }
  return undefined
}

function ttftMs(turn: TurnUsage): number | null {
  return turn.firstTokenAt === undefined ? null : Math.max(0, turn.firstTokenAt - turn.startedAt)
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Clock glyph — a quick visual cue that this readout is a timing figure. */
function LatencyClock(): JSX.Element {
  return (
    <svg
      className="statusbar__icon"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function StatusBar({ requests, usage, onOpenUsage }: StatusBarProps): JSX.Element {
  const scope = useScope()
  const active = usage.activeTurns.some((turn) => !isAmbient(turn))
  const turn = latestAgentTurn(usage)

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
        <LatencyClock />
        Latency
        {turn && ` · TTFT ${formatMs(ttftMs(turn))}`}
        {turn?.finishedAt !== undefined && ` · ${formatMs(turn.finishedAt - turn.startedAt)}`}
      </button>
      <span className="statusbar__item statusbar__item--end">Copilot: ready, read-only</span>
    </footer>
  )
}

export default StatusBar
