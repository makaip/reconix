import { useCallback, useEffect, useState } from 'react'
import type { ConsoleEntry } from '../../../shared/devtools'

const MAX_ENTRIES = 500

export type ConsoleApi = {
  entries: ConsoleEntry[]
  clear: () => void
  evaluate: (expression: string) => Promise<void>
}

/**
 * Console log, fed by the Reconix.consoleEntry/Reconix.consoleCleared events (console.*
 * calls, uncaught exceptions, Log domain messages) and by the REPL below. Subscribes once
 * for the app's lifetime — like useNetworkStats — because entries should accumulate even
 * while the Console tab isn't the active devtools tab (so its badge count stays accurate).
 * Resets on DOM.documentUpdated, same navigation signal the Elements tree already uses.
 */
export function useConsole(): ConsoleApi {
  const [entries, setEntries] = useState<ConsoleEntry[]>([])

  useEffect(
    () =>
      window.reconix.devtools.onEvent((event) => {
        if (event.method === 'Reconix.consoleEntry') {
          setEntries((prev) => [...prev, event.params.entry].slice(-MAX_ENTRIES))
        } else if (event.method === 'Reconix.consoleCleared' || event.method === 'DOM.documentUpdated') {
          setEntries([])
        }
      }),
    []
  )

  const clear = useCallback(() => setEntries([]), [])

  const evaluate = useCallback(async (expression: string): Promise<void> => {
    const trimmed = expression.trim()
    if (!trimmed) return
    const command: ConsoleEntry = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      level: 'log',
      text: trimmed,
      source: 'eval-command',
      timestamp: Date.now()
    }
    setEntries((prev) => [...prev, command].slice(-MAX_ENTRIES))
    const result = await window.reconix.devtools.evaluate(trimmed)
    if (result) setEntries((prev) => [...prev, result].slice(-MAX_ENTRIES))
  }, [])

  return { entries, clear, evaluate }
}
