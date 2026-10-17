import { useEffect, useState } from 'react'
import type { EngineStatus } from '../../../shared/contracts'

/** Tracks the Copilot engine's one-time boot sequence (opencode serve + the
 *  MCP tool server) at app launch. Moves 'starting' -> 'ready' | 'error' once.
 *
 *  Subscribes AND reads the current value back, because main creates the
 *  bridge before this window has loaded: the engine routinely reaches 'ready'
 *  before React mounts, and a push-only subscription would miss that
 *  transition entirely and leave the banner stuck on 'starting'. */
export function useEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>({ status: 'starting' })

  useEffect(() => {
    let live = true
    // Subscribe first so a transition landing mid-readback isn't lost.
    let pushed = false
    const unsubscribe = window.reconix.copilot.onEngineStatus((next) => {
      pushed = true
      if (live) setStatus(next)
    })

    void window.reconix.copilot.getEngineStatus().then((current) => {
      // A pushed event is never older than this readback, so don't let a
      // slow reply clobber it.
      if (live && !pushed) setStatus(current)
    })

    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return status
}
