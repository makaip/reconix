import { useEffect, useState } from 'react'
import type { TurnUsage, UsageSnapshot } from '../../../shared/contracts'

type UsagePanelProps = {
  usage: UsageSnapshot
  onClose: () => void
}

/** Mirrors SELF_HOSTED_PREFIXES in src/main/opencode/pricing.ts (kept local so
 *  the renderer never imports main-process code). */
const SELF_HOSTED_PREFIX = 'vllm-orchestrator/'
const MAX_TURN_ROWS = 25

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** USD for a model's spend, or an em dash when it can't honestly be priced. */
function formatCost(costUsd: number, tokens: number, model?: string): string {
  if (costUsd === 0) {
    if (model && model.startsWith(SELF_HOSTED_PREFIX)) return '$0.00'
    if (tokens > 0) return '—' // tokens spent on a model we have no price for
  }
  return `$${costUsd.toFixed(4)}`
}

function ttftMs(turn: TurnUsage): number | null {
  return turn.firstTokenAt === undefined ? null : Math.max(0, turn.firstTokenAt - turn.startedAt)
}

function durationMs(turn: TurnUsage, now: number): number {
  return Math.max(0, (turn.finishedAt ?? now) - turn.startedAt)
}

const ROLE_LABEL: Record<TurnUsage['role'], string> = {
  orchestrator: 'Orchestrator',
  'dom-analyzer': 'DOM parser',
  subagent: 'Subagent',
  unknown: 'Unknown'
}

/** Ticks once a second so an in-flight turn's "elapsed" keeps moving between pushes. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [enabled])
  return now
}

function UsagePanel({ usage, onClose }: UsagePanelProps): JSX.Element {
  const now = useNow(usage.activeTurns.length > 0)
  const { totals, activeTurns, rollups } = usage

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const recentTurns = usage.turns.slice(-MAX_TURN_ROWS).reverse()
  const empty = totals.turns === 0 && activeTurns.length === 0

  return (
    <div className="dock__panel" role="dialog" aria-label="Cost and latency">
      <header className="settings__header">
        <h2 className="settings__title">Cost &amp; latency</h2>
        <button type="button" className="settings__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="usage__body">
        <dl className="usage__summary">
          <div className="usage__stat">
            <dt className="usage__stat-label">Turns</dt>
            <dd className="usage__stat-value">{totals.turns}</dd>
          </div>
          <div className="usage__stat">
            <dt className="usage__stat-label">DOM refreshes</dt>
            <dd className="usage__stat-value">{totals.parserRefreshes}</dd>
          </div>
          <div className="usage__stat">
            <dt className="usage__stat-label">Input tokens</dt>
            <dd className="usage__stat-value">{formatTokens(totals.inputTokens)}</dd>
          </div>
          <div className="usage__stat">
            <dt className="usage__stat-label">Output tokens</dt>
            <dd className="usage__stat-value">{formatTokens(totals.outputTokens)}</dd>
          </div>
          <div className="usage__stat usage__stat--span">
            <dt className="usage__stat-label">Est. cost</dt>
            <dd className="usage__stat-value">
              {formatCost(totals.costUsd, totals.inputTokens + totals.outputTokens)}
            </dd>
          </div>
        </dl>

        {empty && (
          <p className="usage__empty">
            Nothing yet. Send a prompt and latency figures will appear here as the turn runs.
          </p>
        )}

        {activeTurns.length > 0 && (
          <section className="usage__section">
            <h3 className="usage__section-title">In flight</h3>
            {activeTurns.map((turn) => (
              <div className="usage__live" key={turn.id}>
                <span className="usage__live-dot" aria-hidden="true" />
                <span className="usage__live-role">{ROLE_LABEL[turn.role]}</span>
                <span className="usage__muted">{turn.model}</span>
                <span className="usage__live-stat">TTFT {formatMs(ttftMs(turn))}</span>
                <span className="usage__live-stat">elapsed {formatMs(durationMs(turn, now))}</span>
                <span className="usage__live-stat">
                  {turn.toolCallCount} tool call{turn.toolCallCount === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </section>
        )}

        {recentTurns.length > 0 && (
          <section className="usage__section">
            <h3 className="usage__section-title">Recent turns</h3>
            <div className="usage__scroll">
            <table className="usage__table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Model</th>
                  <th className="usage__num">TTFT</th>
                  <th className="usage__num">Total</th>
                  <th className="usage__num">Tools</th>
                  <th className="usage__num">In / out</th>
                  <th className="usage__num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentTurns.map((turn) => (
                  <tr key={turn.id} className={turn.error ? 'usage__row--error' : undefined}>
                    <td>{ROLE_LABEL[turn.role]}</td>
                    <td className="usage__muted usage__name" title={turn.model}>
                      {turn.model}
                    </td>
                    <td className="usage__num">{formatMs(ttftMs(turn))}</td>
                    <td className="usage__num">{formatMs(durationMs(turn, now))}</td>
                    <td className="usage__num">
                      {turn.toolCallCount}
                      {turn.toolErrorCount > 0 && <span className="usage__bad"> ·{turn.toolErrorCount}</span>}
                    </td>
                    <td className="usage__num">
                      {formatTokens(turn.inputTokens ?? 0)} / {formatTokens(turn.outputTokens ?? 0)}
                    </td>
                    <td className="usage__num">
                      {formatCost(
                        turn.reportedCostUsd ?? 0,
                        (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0),
                        turn.model
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        )}

        {rollups.byModel.length > 0 && (
          <section className="usage__section">
            <h3 className="usage__section-title">By model</h3>
            <div className="usage__scroll">
            <table className="usage__table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="usage__num">Calls</th>
                  <th className="usage__num">p50</th>
                  <th className="usage__num">p95</th>
                  <th className="usage__num">Tokens</th>
                  <th className="usage__num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rollups.byModel.map((row) => (
                  <tr key={row.model}>
                    <td className="usage__muted usage__name" title={row.model}>
                      {row.model}
                    </td>
                    <td className="usage__num">{row.calls}</td>
                    <td className="usage__num">{formatMs(row.p50Ms)}</td>
                    <td className="usage__num">{formatMs(row.p95Ms)}</td>
                    <td className="usage__num">
                      {formatTokens(row.inputTokens + row.outputTokens)}
                    </td>
                    <td className="usage__num">
                      {formatCost(row.costUsd, row.inputTokens + row.outputTokens, row.model)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        )}

        {rollups.byTool.length > 0 && (
          <section className="usage__section">
            <h3 className="usage__section-title">By tool</h3>
            <div className="usage__scroll">
            <table className="usage__table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th className="usage__num">Calls</th>
                  <th className="usage__num">Errors</th>
                  <th className="usage__num">p50</th>
                  <th className="usage__num">p95</th>
                </tr>
              </thead>
              <tbody>
                {rollups.byTool.map((row) => (
                  <tr key={row.tool}>
                    <td className="usage__name" title={row.tool}>
                      {row.tool}
                    </td>
                    <td className="usage__num">{row.calls}</td>
                    <td className="usage__num">
                      {row.errors > 0 ? <span className="usage__bad">{row.errors}</span> : 0}
                    </td>
                    <td className="usage__num">{formatMs(row.p50Ms)}</td>
                    <td className="usage__num">{formatMs(row.p95Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export default UsagePanel
