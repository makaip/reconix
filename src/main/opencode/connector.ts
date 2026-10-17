// OpenCode connector (ARCHITECTURE §5.B). Owns the session lifecycle and is the
// ONLY thing that talks to OpenCode. For every raw event it does two things in
// one pass (API.md §2.1): (1) fan out a normalized AgentEvent, (2) persist to
// the store. Audit is a side effect of the event passing through — never a
// separate call. Also relays approvals back through the transport.

import type { AgentEvent, ApprovalDecision, ServerStatus } from '../../shared/contracts'
import type { OpenCodeTransport, RawEvent } from './transport'
import { normalize } from './normalize'

export interface ConnectorSinks {
  onAgentEvent(ev: AgentEvent): void // → renderer as agent:event (6.1)
  persist(raw: RawEvent, normalized: AgentEvent | null): void // → engagement store (6.4)
  onStatus(status: ServerStatus): void // → renderer as server:status
}

export interface ConnectorOptions {
  readinessTimeoutMs?: number
  maxBackoffMs?: number
}

export class OpenCodeConnector {
  private sessionId: string | null = null
  private abort: AbortController | null = null
  private stopped = false
  private backoff = 500
  // approvalId → the raw permissionId the transport expects back.
  private readonly pendingApprovals = new Map<string, string>()

  constructor(
    private readonly transport: OpenCodeTransport,
    private readonly sinks: ConnectorSinks,
    private readonly opts: ConnectorOptions = {}
  ) {}

  async start(): Promise<string> {
    this.sinks.onStatus({ state: 'starting' })
    await this.waitForReady()
    const { id } = await this.transport.createSession()
    this.sessionId = id
    this.sinks.onStatus({ state: 'ready' })
    void this.streamLoop() // fire-and-supervise
    return id
  }

  async sendMessage(text: string): Promise<{ messageId: string }> {
    if (!this.sessionId) throw new Error('no active session')
    return this.transport.sendMessage(this.sessionId, text)
  }

  async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.sessionId) throw new Error('no active session')
    const permissionId = this.pendingApprovals.get(approvalId) ?? approvalId
    this.pendingApprovals.delete(approvalId)
    await this.transport.respondPermission(this.sessionId, permissionId, decision)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort?.abort()
    if (this.sessionId) await this.transport.abort(this.sessionId).catch(() => undefined)
    this.sinks.onStatus({ state: 'down' })
  }

  /** Interrupts the agent's current turn without tearing down the session —
   *  the stream loop and connector stay alive, so the user can send another
   *  message right after. Distinct from stop(), which kills everything. */
  async interrupt(): Promise<void> {
    if (!this.sessionId) return
    await this.transport.abort(this.sessionId)
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + (this.opts.readinessTimeoutMs ?? 30_000)
    while (Date.now() < deadline) {
      if (await this.transport.health()) return
      await delay(300)
    }
    throw new Error('OpenCode did not become ready in time')
  }

  // Subscribe, normalize+persist each event, and auto-restart with backoff.
  private async streamLoop(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController()
      try {
        for await (const raw of this.transport.subscribe(this.abort.signal)) {
          this.handle(raw)
        }
        // A clean end of an SSE stream is unexpected (it should stay open); back
        // off before reconnecting so we never tight-loop re-subscribing.
        this.backoff = 500
        if (!this.stopped) await delay(this.backoff)
      } catch (err) {
        if (this.stopped) return
        this.sinks.onStatus({ state: 'reconnecting', detail: String(err) })
        await delay(this.backoff)
        this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 10_000)
      }
    }
  }

  private handle(raw: RawEvent): void {
    const ev = normalize(raw)
    // (2) persist first so the audit record exists even if the UI push throws.
    this.sinks.persist(raw, ev)
    if (!ev) return
    if (ev.kind === 'approval.request') this.pendingApprovals.set(ev.approvalId, ev.approvalId)
    // (1) fan out to the renderer.
    this.sinks.onAgentEvent(ev)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
