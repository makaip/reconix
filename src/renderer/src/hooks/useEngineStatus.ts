import { useEffect, useState } from 'react'
import type { EngineStatus } from '../../../shared/contracts'

/** Tracks the Copilot engine's one-time boot sequence (opencode serve + the
 *  MCP tool server) at app launch. Starts 'starting' — main always fires
 *  that first — and moves to 'ready' or 'error' once, never flaps back. */
export function useEngineStatus(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>({ status: 'starting' })

  useEffect(() => window.reconix.copilot.onEngineStatus(setStatus), [])

  return status
}
