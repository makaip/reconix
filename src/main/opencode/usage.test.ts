import { describe, expect, it } from 'vitest'
import type { TurnUsage } from '../../shared/contracts'
import { UsageMeter, extractUsage, turnCostUsd } from './usage'
import { estimateCostUsd, isSelfHosted, priceFor } from './pricing'

/** Deterministic clock the tests advance by hand. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('UsageMeter turn latency', () => {
  it('measures TTFT, turn duration and pairs each tool call', () => {
    const c = clock()
    const meter = new UsageMeter({ now: c.now, modelForRole: () => 'vllm-orchestrator/orchestrator-model' })
    meter.registerSession('ses-1', 'orchestrator')

    meter.noteSend() // t=1000
    c.advance(200)
    meter.recordAgentEvent({ kind: 'reasoning.delta', messageId: 'm1', text: 'thinking' }) // 1200
    c.advance(100)
    meter.recordAgentEvent({ kind: 'tool.call', callId: 'c1', tool: 'navigate', params: {}, riskTier: 'R' }) // 1300
    c.advance(500)
    meter.recordAgentEvent({ kind: 'tool.result', callId: 'c1', ok: true }) // 1800
    c.advance(300)
    meter.recordAgentEvent({ kind: 'turn.done', messageId: 'm1' }) // 2100

    const snap = meter.snapshot()
    expect(snap.turns).toHaveLength(1)
    const turn = snap.turns[0]
    expect(turn.id).toBe('m1')
    expect(turn.firstTokenAt).toBe(1200)
    expect(turn.finishedAt).toBe(2100)
    expect(turn.toolCallCount).toBe(1)
    expect(turn.toolLatencies).toEqual([{ tool: 'navigate', callId: 'c1', ms: 500, ok: true }])
    expect(snap.rollups.byTool).toEqual([
      { tool: 'navigate', calls: 1, errors: 0, p50Ms: 500, p95Ms: 500 }
    ])
  })

  it('exposes the in-flight turn via activeTurns, then settles it', () => {
    const c = clock()
    const meter = new UsageMeter({ now: c.now, modelForRole: () => 'vllm-orchestrator/orchestrator-model' })
    meter.registerSession('ses-1', 'orchestrator')

    meter.noteSend() // t=1000
    c.advance(150)
    meter.recordAgentEvent({ kind: 'message.delta', messageId: 'm1', role: 'assistant', text: 'hi' }) // 1150

    const live = meter.snapshot()
    expect(live.activeTurns).toHaveLength(1)
    expect(live.activeTurns[0].firstTokenAt).toBe(1150)
    expect(live.turns).toHaveLength(0)

    c.advance(50)
    meter.recordAgentEvent({ kind: 'turn.done', messageId: 'm1' }) // 1200
    const settled = meter.snapshot()
    expect(settled.activeTurns).toHaveLength(0)
    expect(settled.turns).toHaveLength(1)
    expect(settled.turns[0].finishedAt).toBe(1200)
  })

  it('counts tool errors without dropping the latency sample', () => {
    const c = clock()
    const meter = new UsageMeter({ now: c.now })
    meter.registerSession('s', 'orchestrator')
    meter.noteSend()
    meter.recordAgentEvent({ kind: 'tool.call', callId: 'x', tool: 'eval_in_page', params: {}, riskTier: 'P' })
    c.advance(120)
    meter.recordAgentEvent({ kind: 'tool.result', callId: 'x', ok: false, error: 'boom' })
    meter.recordAgentEvent({ kind: 'turn.done', messageId: 'm' })

    const turn = meter.snapshot().turns[0]
    expect(turn.toolErrorCount).toBe(1)
    expect(turn.toolLatencies[0].ok).toBe(false)
  })
})

describe('UsageMeter token + cost extraction', () => {
  it('attaches usage reported for the orchestrator session to the open turn', () => {
    const c = clock()
    const meter = new UsageMeter({ now: c.now, modelForRole: () => 'vllm-orchestrator/orchestrator-model' })
    meter.registerSession('ses-1', 'orchestrator')
    meter.noteSend()
    meter.recordRaw({
      type: 'session.message.updated',
      data: { assistantMessageID: 'm1', usage: { inputTokens: 1000, outputTokens: 500 } },
      durable: { aggregateID: 'ses-1' }
    })
    meter.recordAgentEvent({ kind: 'turn.done', messageId: 'm1' })

    const snap = meter.snapshot()
    expect(snap.turns[0].inputTokens).toBe(1000)
    expect(snap.turns[0].outputTokens).toBe(500)
    // The local orchestrator is self-hosted => free at the margin.
    expect(snap.totals.costUsd).toBe(0)
  })

  it('prices a priced model from the table (input + output)', () => {
    const c = clock()
    const meter = new UsageMeter({ now: c.now, modelForRole: () => 'gemini/gemini-flash-lite-latest' })
    meter.registerSession('s', 'orchestrator')
    meter.noteSend()
    meter.recordAgentEvent({ kind: 'message.delta', messageId: 'm', role: 'assistant', text: 'hi' })
    meter.recordRaw({
      type: 'x',
      data: { usage: { promptTokens: 2_000_000, completionTokens: 1_000_000 } },
      durable: { aggregateID: 's' }
    })
    meter.recordAgentEvent({ kind: 'turn.done', messageId: 'm' })

    // 2M * 0.075 + 1M * 0.30 = 0.15 + 0.30 = 0.45
    const snap = meter.snapshot()
    expect(snap.totals.costUsd).toBeCloseTo(0.45, 6)
    expect(snap.rollups.byModel[0]).toMatchObject({
      model: 'gemini/gemini-flash-lite-latest',
      calls: 1,
      inputTokens: 2_000_000,
      outputTokens: 1_000_000
    })
  })

  it('prefers a reported cost over the local estimate', () => {
    const turn: TurnUsage = {
      id: 'm',
      sessionId: 's',
      role: 'orchestrator',
      model: 'gemini/gemini-flash-lite-latest',
      startedAt: 0,
      finishedAt: 1,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reportedCostUsd: 9,
      toolCallCount: 0,
      toolErrorCount: 0,
      toolLatencies: []
    }
    expect(turnCostUsd(turn)).toBe(9)
  })
})

describe('UsageMeter role attribution + ambient calls', () => {
  it('counts DOM-parser refreshes and attributes them to dom-analyzer', () => {
    const c = clock()
    const meter = new UsageMeter({
      now: c.now,
      modelForRole: (role) => (role === 'dom-analyzer' ? 'gemini/gemini-flash-lite-latest' : 'unknown')
    })
    meter.noteAmbientCall('dom-analyzer', 800)
    meter.noteAmbientCall('dom-analyzer', 1200)

    const snap = meter.snapshot()
    expect(snap.totals.parserRefreshes).toBe(2)
    const role = snap.rollups.byRole.find((r) => r.role === 'dom-analyzer')
    expect(role?.calls).toBe(2)
  })
})

describe('UsageMeter ring buffer', () => {
  it('evicts the oldest turn past maxTurns', () => {
    const c = clock()
    const meter = new UsageMeter({ now: c.now, maxTurns: 2 })
    meter.registerSession('s', 'orchestrator')
    for (let i = 0; i < 3; i++) {
      meter.noteSend()
      meter.recordAgentEvent({ kind: 'message.delta', messageId: `m${i}`, role: 'assistant', text: 'x' })
      meter.recordAgentEvent({ kind: 'turn.done', messageId: `m${i}` })
    }
    const ids = meter.snapshot().turns.map((t) => t.id)
    expect(ids).toEqual(['m1', 'm2'])
  })
})

describe('extractUsage', () => {
  it('reads nested usage with common field spellings', () => {
    expect(extractUsage({ usage: { promptTokens: 5, completionTokens: 6, cost: 0.01 } })).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      reportedCostUsd: 0.01
    })
  })

  it('reads a flat data object', () => {
    expect(extractUsage({ inputTokens: 3 })).toMatchObject({ inputTokens: 3 })
  })

  it('returns null when no usage is present', () => {
    expect(extractUsage({ foo: 'bar' })).toBeNull()
    expect(extractUsage(null)).toBeNull()
  })
})

describe('pricing', () => {
  it('marks the local vLLM provider self-hosted and free', () => {
    expect(isSelfHosted('vllm-orchestrator/orchestrator-model')).toBe(true)
    expect(priceFor('vllm-orchestrator/orchestrator-model')).toEqual({ input: 0, output: 0 })
    expect(estimateCostUsd('vllm-orchestrator/orchestrator-model', 1_000_000, 1_000_000)).toBe(0)
  })

  it('returns undefined for an unknown model so the UI can show a dash', () => {
    expect(priceFor('mystery/model')).toBeUndefined()
    expect(estimateCostUsd('mystery/model', 1000, 1000)).toBeUndefined()
  })
})
