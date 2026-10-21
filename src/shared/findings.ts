// Canonical finding contract. One shape for both the legacy agent-session
// manager (`session.ts` → `finding:new`) and the live Copilot MCP pipeline
// (`record_finding` → the findings panel). Previously the renderer's mock data
// and the session manager each declared their own `Finding`, which is exactly
// the duplication the preload's TODO called out — this is the single source.

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** Triage state of a finding. New findings start 'open'. */
export type FindingStatus = 'open' | 'confirmed' | 'false-positive' | 'fixed'

export interface Finding {
  id: string
  title: string
  severity: FindingSeverity
  /** Legacy session-manager task link. Absent for MCP-recorded findings, which
   *  carry an `evidenceRef` instead and aren't tied to the mock task graph. */
  taskId?: string
  /** Triage state. Omitted for untouched findings (equivalent to 'open'). */
  status?: FindingStatus
  /** Free-form analyst note. Omitted when never written. */
  notes?: string
  /** CVSS base score (0..10), absent when unset. */
  cvss?: number
}

/** Partial triage write: only the keys present are updated. `null` clears a
 *  column (notes/cvss); status can't be cleared. */
export interface FindingTriagePatch {
  status?: FindingStatus
  notes?: string | null
  cvss?: number | null
}

