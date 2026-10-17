import { useEffect, useState } from 'react'
import type { WsConnection } from '../../../shared/tabs'

/**
 * WebSocket connections + frames for the inspected target, kept live via
 * websocket:changed. Capture is per-target and resets when the inspected page
 * changes, so this re-lists whenever the active tab changes.
 */
export function useWebSocket(activeTabId: number | null): WsConnection[] {
  const [conns, setConns] = useState<WsConnection[]>([])

  useEffect(() => {
    setConns([])
    let live = true
    void window.reconix.websocket.list().then((initial) => {
      if (live) setConns(initial)
    })
    const unsubscribe = window.reconix.websocket.onChanged((all) => setConns(all))
    return () => {
      live = false
      unsubscribe()
    }
  }, [activeTabId])

  return conns
}
