import { useEffect, useState } from 'react'
import type { DiffResponsesOutput } from '../../../shared/tools'
import type { SaveRequestInput, SavedRequest } from '../../../shared/tabs'

export type RepeaterApi = {
  saved: SavedRequest[]
  save: (input: SaveRequestInput) => Promise<SavedRequest | null>
  remove: (id: string) => Promise<boolean>
  send: (id: string) => Promise<SavedRequest | null>
  diff: (payload: { id: string; aIndex?: number; bIndex?: number }) => Promise<DiffResponsesOutput | null>
}

/** Live view of Repeater's saved requests, kept in sync via repeater:changed. */
export function useRepeater(): RepeaterApi {
  const [saved, setSaved] = useState<SavedRequest[]>([])

  useEffect(() => {
    let live = true
    void window.reconix.repeater.list().then((initial) => {
      if (live) setSaved(initial)
    })
    const unsubscribe = window.reconix.repeater.onChanged(setSaved)
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return {
    saved,
    save: window.reconix.repeater.save,
    remove: window.reconix.repeater.delete,
    send: window.reconix.repeater.send,
    diff: window.reconix.repeater.diff
  }
}
