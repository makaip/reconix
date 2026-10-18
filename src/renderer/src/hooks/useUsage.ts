import { useEffect, useState } from 'react'
import type { UsageSnapshot } from '../../../shared/contracts'

const EMPTY: UsageSnapshot = {
  turns: [],
  activeTurns: [],
  rollups: { byModel: [], byRole: [], byTool: [] },
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, parserRefreshes: 0 }
}

/**
 * Cost/latency figures for the agentic pipeline (counts + timing only).
 * Seeds from a one-shot readback — the live push can fire before we subscribe
 * (main pushes while generating) — then follows `copilot:usage` updates.
 */
export function useUsage(): UsageSnapshot {
  const [usage, setUsage] = useState<UsageSnapshot>(EMPTY)

  useEffect(() => {
    let live = true
    void window.reconix.copilot.getUsage().then((initial) => {
      if (live && initial) setUsage(initial)
    })
    const unsubscribe = window.reconix.copilot.onUsage(setUsage)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return usage
}
