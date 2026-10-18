// Renderer-facing engagement contract (ARCHITECTURE §6.4 `engagements` table).
// An engagement is one authorized run: a goal over a loaded scope, with its
// policy, recorded when it starts and when it stops.

export type EngagementStatus = 'active' | 'stopped'

export interface EngagementRow {
  id: string
  goal: string
  scope: unknown
  policy: unknown
  startedAt: number
  stoppedAt: number | null
  status: EngagementStatus
}
