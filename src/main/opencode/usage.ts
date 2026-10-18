// Cost/latency meter for the OpenCode pipeline (cost-latency-dashboard.md).
//
// Capture point: every raw SSE event passes through the connector's `persist`
// sink (including subagent + background DOM-parser sessions), and the
// orchestrator's normalized AgentEvents pass through `onAgentEvent`. The meter
// subscribes to both, so it sees the full pipeline without any new plumbing.
//
// Latency is computed entirely from local timestamps (send -> first token ->
// turn.done; tool.call -> tool.result). Token/cost extraction from raw events is
// deliberately tolerant: the exact usage-bearing event shape is pinned in
// Phase 0 (capture spike), so nothing here depends on a specific field being
// present. Counts and timing only — never prompt/response text.

import type {
  AgentEvent,
  AgentRole,
  ModelRollup,
  RoleRollup,
  ToolRollup,
  TurnUsage,
  UsageSnapshot
} from '../../shared/contracts'
import type { RawEvent } from './transport'
import { estimateCostUsd, isSelfHosted, priceFor } from './pricing'

const DEFAULT_MAX_TURNS = 1000

export interface UsageMeterOptions {
  /** Resolve the "provider/model" a role runs on. */
  modelForRole?: (role: AgentRole) => string
  /** Ring-buffer cap on retained turns (most-recent-last). */
  maxTurns?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/** A turn still being assembled (not yet settled into the ring buffer). */
type OpenTurn = TurnUsage

/** Best-effort partial token/cost figures scraped from a raw SSE event. */
export interface ExtractedUsage {
  inputTokens?: number
  outputTokens?: number
  reportedCostUsd?: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** First defined number among the given keys on `source`. */
function pick(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = num(source[key])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Scan a raw event's `data` for token/cost figures. OpenCode's exact field
 * names are confirmed in Phase 0; this accepts the common spellings so it works
 * with either a flat `data` or a nested `data.usage`, and simply returns null
 * when nothing is found.
 */
export function extractUsage(data: unknown): ExtractedUsage | null {
  const d = asRecord(data)
  if (!d) return null

  const usage = asRecord(d.usage) ?? d
  const inputTokens = pick(usage, ['inputTokens', 'promptTokens', 'input_tokens', 'input'])
  const outputTokens = pick(usage, ['outputTokens', 'completionTokens', 'output_tokens', 'output'])
  const reportedCostUsd = pick(usage, ['cost', 'costUsd', 'totalCost']) ?? pick(d, ['cost', 'costUsd'])

  if (inputTokens === undefined && outputTokens === undefined && reportedCostUsd === undefined) {
    return null
  }
  return { inputTokens, outputTokens, reportedCostUsd }
}

function sessionIdOf(raw: RawEvent): string | undefined {
  const durable = asRecord(raw.durable)
  const aggregate = durable?.aggregateID
  return typeof aggregate === 'string' && aggregate.length > 0 ? aggregate : undefined
}

function defaultModelForRole(role: AgentRole): string {
  return role === 'orchestrator' ? 'unknown/orchestrator' : 'unknown'
}

function percentile(sortedMs: number[], p: number): number | null {
  if (sortedMs.length === 0) return null
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length))
  return sortedMs[index]
}

/** Settled turn duration, or null if the turn never finished. */
function turnDuration(turn: TurnUsage): number | null {
  if (turn.finishedAt === undefined) return null
  return Math.max(0, turn.finishedAt - turn.startedAt)
}

/** Cost for a turn: prefer OpenCode's figure, else compute from the price table. */
export function turnCostUsd(turn: TurnUsage): number | undefined {
  if (turn.reportedCostUsd !== undefined) return turn.reportedCostUsd
  if (isSelfHosted(turn.model)) return 0
  if (!priceFor(turn.model)) return undefined
  return estimateCostUsd(turn.model, turn.inputTokens ?? 0, turn.outputTokens ?? 0)
}

export class UsageMeter {
  private readonly turns: TurnUsage[] = []
  private readonly active = new Map<string, OpenTurn>()
  /** callId -> start time, to pair tool.call with tool.result. */
  private readonly toolStarts = new Map<string, { tool: string; at: number }>()
  private readonly sessionRoles = new Map<string, AgentRole>()
  private orchestratorSessionId: string | null = null
  private turnSeq = 0
  private ambientSeq = 0

  private readonly maxTurns: number
  private readonly modelForRole: (role: AgentRole) => string
  private readonly now: () => number

  constructor(opts: UsageMeterOptions = {}) {
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
    this.modelForRole = opts.modelForRole ?? defaultModelForRole
    this.now = opts.now ?? (() => Date.now())
  }

  /** Tell the meter which session id belongs to which pipeline role. */
  registerSession(sessionId: string, role: AgentRole): void {
    this.sessionRoles.set(sessionId, role)
    if (role === 'orchestrator') this.orchestratorSessionId = sessionId
  }

  /** A user message was just sent to the orchestrator: open a fresh turn. */
  noteSend(sessionId?: string, at = this.now()): void {
    const sid = sessionId ?? this.orchestratorSessionId
    if (!sid) return
    this.settle(sid, at) // close any dangling turn before opening a new one
    this.active.set(sid, {
      id: `turn-${++this.turnSeq}`,
      sessionId: sid,
      role: 'orchestrator',
      model: this.modelForRole('orchestrator'),
      startedAt: at,
      toolCallCount: 0,
      toolErrorCount: 0,
      toolLatencies: []
    })
  }

  /**
   * Record a background call the meter can't get session/deltas for — chiefly a
   * DOM-parser refresh (whole-call duration, no token attribution).
   */
  noteAmbientCall(role: AgentRole, ms: number, at = this.now()): void {
    this.push({
      id: `ambient-${++this.ambientSeq}`,
      sessionId: '',
      role,
      model: this.modelForRole(role),
      startedAt: Math.max(0, at - Math.max(0, ms)),
      finishedAt: at,
      toolCallCount: 0,
      toolErrorCount: 0,
      toolLatencies: []
    })
  }

  /** Feed a raw SSE event (persist sink). Token/cost only — timing comes from agent events. */
  recordRaw(raw: RawEvent, _at = this.now()): void {
    const usage = extractUsage(raw.data)
    if (!usage) return
    const sessionId = sessionIdOf(raw)
    const turn = sessionId ? this.active.get(sessionId) : this.orchestratorTurn()
    if (!turn) return
    if (usage.inputTokens !== undefined) turn.inputTokens = usage.inputTokens
    if (usage.outputTokens !== undefined) turn.outputTokens = usage.outputTokens
    if (usage.reportedCostUsd !== undefined) turn.reportedCostUsd = usage.reportedCostUsd
  }

  /** Feed a normalized orchestrator event (onAgentEvent sink). */
  recordAgentEvent(ev: AgentEvent, at = this.now()): void {
    switch (ev.kind) {
      case 'message.delta':
      case 'reasoning.delta': {
        const turn = this.orchestratorTurn()
        if (!turn) return
        if (turn.firstTokenAt === undefined) turn.firstTokenAt = at
        if (turn.id.startsWith('turn-')) turn.id = ev.messageId
        return
      }
      case 'tool.call': {
        this.toolStarts.set(ev.callId, { tool: ev.tool, at })
        const turn = this.orchestratorTurn()
        if (turn) turn.toolCallCount += 1
        return
      }
      case 'tool.result': {
        const start = this.toolStarts.get(ev.callId)
        this.toolStarts.delete(ev.callId)
        const turn = this.orchestratorTurn()
        if (!turn || !start) return
        turn.toolLatencies.push({
          tool: start.tool,
          callId: ev.callId,
          ms: Math.max(0, at - start.at),
          ok: ev.ok
        })
        if (!ev.ok) turn.toolErrorCount += 1
        return
      }
      case 'turn.done': {
        this.finishOrchestrator(at)
        return
      }
      case 'error': {
        const turn = this.orchestratorTurn()
        if (turn) turn.error = true
        this.finishOrchestrator(at)
        return
      }
      default:
        return
    }
  }

  /** Current snapshot: retained turns plus per-model/role/tool rollups. */
  snapshot(): UsageSnapshot {
    const turns = [...this.turns]
    return {
      turns,
      // Copy in-flight turns (and their arrays) so callers can't mutate meter
      // state, and a turn being fed mid-snapshot isn't observed half-updated.
      activeTurns: [...this.active.values()].map((turn) => ({
        ...turn,
        toolLatencies: [...turn.toolLatencies]
      })),
      rollups: this.rollups(turns),
      totals: this.totals(turns)
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private orchestratorTurn(): OpenTurn | undefined {
    return this.orchestratorSessionId ? this.active.get(this.orchestratorSessionId) : undefined
  }

  private finishOrchestrator(at: number): void {
    if (this.orchestratorSessionId) this.settle(this.orchestratorSessionId, at)
  }

  private settle(sessionId: string, at: number): void {
    const turn = this.active.get(sessionId)
    if (!turn) return
    this.active.delete(sessionId)
    this.push({ ...turn, finishedAt: at, toolLatencies: [...turn.toolLatencies] })
  }

  private push(turn: TurnUsage): void {
    this.turns.push(turn)
    while (this.turns.length > this.maxTurns) this.turns.shift()
  }

  private rollups(turns: TurnUsage[]): UsageSnapshot['rollups'] {
    const byModel = new Map<string, { calls: number; input: number; output: number; cost: number; ms: number[] }>()
    const byRole = new Map<AgentRole, { calls: number; input: number; output: number; cost: number }>()
    const byTool = new Map<string, { calls: number; errors: number; ms: number[] }>()

    for (const turn of turns) {
      const cost = turnCostUsd(turn) ?? 0
      const input = turn.inputTokens ?? 0
      const output = turn.outputTokens ?? 0
      const duration = turnDuration(turn)

      const model = byModel.get(turn.model) ?? { calls: 0, input: 0, output: 0, cost: 0, ms: [] }
      model.calls += 1
      model.input += input
      model.output += output
      model.cost += cost
      if (duration !== null) model.ms.push(duration)
      byModel.set(turn.model, model)

      const role = byRole.get(turn.role) ?? { calls: 0, input: 0, output: 0, cost: 0 }
      role.calls += 1
      role.input += input
      role.output += output
      role.cost += cost
      byRole.set(turn.role, role)

      for (const latency of turn.toolLatencies) {
        const tool = byTool.get(latency.tool) ?? { calls: 0, errors: 0, ms: [] }
        tool.calls += 1
        if (!latency.ok) tool.errors += 1
        tool.ms.push(latency.ms)
        byTool.set(latency.tool, tool)
      }
    }

    const modelRollups: ModelRollup[] = [...byModel.entries()]
      .map(([model, agg]) => {
        const sorted = agg.ms.slice().sort((a, b) => a - b)
        return {
          model,
          calls: agg.calls,
          inputTokens: agg.input,
          outputTokens: agg.output,
          costUsd: agg.cost,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95)
        }
      })
      .sort((a, b) => b.calls - a.calls)

    const roleRollups: RoleRollup[] = [...byRole.entries()]
      .map(([role, agg]) => ({
        role,
        calls: agg.calls,
        inputTokens: agg.input,
        outputTokens: agg.output,
        costUsd: agg.cost
      }))
      .sort((a, b) => b.calls - a.calls)

    const toolRollups: ToolRollup[] = [...byTool.entries()]
      .map(([tool, agg]) => {
        const sorted = agg.ms.slice().sort((a, b) => a - b)
        return {
          tool,
          calls: agg.calls,
          errors: agg.errors,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95)
        }
      })
      .sort((a, b) => b.calls - a.calls)

    return { byModel: modelRollups, byRole: roleRollups, byTool: toolRollups }
  }

  private totals(turns: TurnUsage[]): UsageSnapshot['totals'] {
    let inputTokens = 0
    let outputTokens = 0
    let costUsd = 0
    let parserRefreshes = 0
    for (const turn of turns) {
      inputTokens += turn.inputTokens ?? 0
      outputTokens += turn.outputTokens ?? 0
      costUsd += turnCostUsd(turn) ?? 0
      if (turn.role === 'dom-analyzer') parserRefreshes += 1
    }
    return { inputTokens, outputTokens, costUsd, turns: turns.length, parserRefreshes }
  }
}
