import type { TurnUsage, UsageSnapshot } from '../../../../shared/contracts'
import { useRuntimeStatus } from '../../hooks/useRuntimeStatus'
import { useScope } from '../../hooks/useScope'

type StatusBarProps = {
  requests: number
  usage: UsageSnapshot
  onOpenUsage: () => void
  onOpenTraces: () => void
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

/** Picture-frame glyph — cues that this readout is captured evidence. */
function TraceGlyph(): JSX.Element {
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
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17l4.5-4 3 2.5 3.5-3.5L20 16" />
    </svg>
  )
}

function StatusBar({ requests, usage, onOpenUsage, onOpenTraces }: StatusBarProps): JSX.Element {
  const scope = useScope()
  const { proxy, engagement } = useRuntimeStatus()
  const active = usage.activeTurns.some((turn) => !isAmbient(turn))
  const turn = latestAgentTurn(usage)

  return (
    <footer className="statusbar">
      <span className="statusbar__item">Proxy: {proxy.address ?? 'none'}</span>
      {engagement && <span className="statusbar__item">Engagement: {engagement}</span>}
      <span className="statusbar__item">Scope: {scope.summary}</span>
      <span className="statusbar__item">Requests: {requests}</span>
      <span className="statusbar__spacer" />
      <button
        type="button"
        className="statusbar__button"
        onClick={onOpenTraces}
        title="Browse captured evidence traces"
      >
        <TraceGlyph />
        Traces
      </button>
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
