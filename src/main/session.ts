import { BrowserWindow, ipcMain } from 'electron'
import type {
  AgentEvent,
  AgentSessionState,
  AgentTask,
  ApprovalDecision,
  ApprovalRequest,
  Finding,
  RunState,
  SendMessageParams,
  StartAgentParams,
  ToolDescriptor
} from '../shared/agent'

// Static stand-in for the real Tool Registry (arch.md §6), which doesn't exist yet.
// Mirrors the 3 MVP tools named in arch.md §7 so `tool:list` has something real to show.
const STUB_TOOLS: ToolDescriptor[] = [
  {
    name: 'xss-payload-injector',
    description: 'Injects XSS probe payloads into form fields',
    riskTier: 'mutating'
  },
  {
    name: 'csrf-token-checker',
    description: 'Checks whether state-changing requests require a CSRF token',
    riskTier: 'read-only'
  },
  {
    name: 'param-fuzzer',
    description: 'Fuzzes request parameters for anomalous responses',
    riskTier: 'mutating'
  }
]

let nextId = 1
const newId = (prefix: string): string => `${prefix}-${nextId++}`

export type SessionManager = {
  getState: () => AgentSessionState
}

// Distributive Omit so each `agent:event` variant keeps its own discriminant/fields
// when we assign the emitter-owned ordering metadata (id/seq/ts).
type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
type AgentEventInput = DistOmit<AgentEvent, 'id' | 'seq' | 'ts'>

/**
 * Owns the current engagement: run state, task graph, and the approval queue
 * (arch.md §3.3). This is a stand-in for the real OpenCode-driven planner (§3.4) —
 * `agent:start` seeds a fixed task graph instead of calling out to a planner, so the
 * IPC contract (§5/§6.1) and the approval gate (§6.4) can be built and exercised
 * before that integration lands. Per §7 Phase 0, the transcript is driven entirely by
 * a MOCK `agent:event` emitter + fake approval resolver — no network / OpenCode calls.
 */
export function createSessionManager(win: BrowserWindow): SessionManager {
  let state: AgentSessionState = {
    runId: null,
    state: 'idle',
    goal: null,
    scope: null,
    tasks: []
  }
  const pendingApprovals = new Map<string, ApprovalRequest>()
  // Links a pending approval back to the tool-call it gates so the resolution can
  // emit a matching tool-result event into the transcript.
  const approvalMeta = new Map<string, { callId: string; tool: string }>()

  let nextSeq = 1

  const emit = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }

  // Pushes one normalized event onto the single transcript stream (arch.md §6.1).
  // The emitter stamps the stable id + monotonic ordering key here.
  const emitEvent = (event: AgentEventInput): void => {
    const full = { ...event, id: newId('evt'), seq: nextSeq++, ts: Date.now() } as AgentEvent
    emit('agent:event', full)
  }

  const emitSession = (): void => emit('agent:state', state)

  const setRunState = (next: RunState): void => {
    state = { ...state, state: next }
    emitSession()
  }

  const updateTask = (taskId: string, patch: Partial<AgentTask>): void => {
    state = {
      ...state,
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
    }
    emit('plan:update', state.tasks)
  }

  // Mock mapping from a planned task to the tool the stand-in planner would pick.
  // read-only tasks run a passive check; mutating/destructive tasks carry a probe
  // payload (kept here only as text — it is never parsed as markup anywhere, §5.A).
  const toolForTask = (task: AgentTask): { tool: string; args: Record<string, string> } => {
    if (task.riskTier === 'read-only') {
      return { tool: 'csrf-token-checker', args: { target: task.title } }
    }
    return {
      tool: 'xss-payload-injector',
      args: { target: task.title, payload: '"><svg onload=alert(1)>' }
    }
  }

  // Runs the next pending task: read-only tasks auto-execute, anything else is gated
  // behind an inline approval event (arch.md §6.1, §6.4). Both paths stream a tool-call
  // (and, for read-only, a tool-result) onto the transcript.
  const advance = (): void => {
    if (state.state !== 'running') return
    const task = state.tasks.find((t) => t.status === 'pending')
    if (!task) {
      setRunState('idle')
      return
    }
    const callId = newId('call')
    const { tool, args } = toolForTask(task)
    emitEvent({ kind: 'reasoning', text: `Next step: ${task.title}.` })
    emitEvent({ kind: 'tool-call', callId, tool, riskTier: task.riskTier, args })

    if (task.riskTier === 'read-only') {
      updateTask(task.id, { status: 'running' })
      finishTask(task.id, callId, tool)
      return
    }

    const approvalId = newId('approval')
    const diffPreview = `Run ${tool} against "${task.title}" (${task.riskTier})`
    const request: ApprovalRequest = {
      approvalId,
      taskId: task.id,
      action: task.title,
      riskTier: task.riskTier,
      diffPreview
    }
    pendingApprovals.set(approvalId, request)
    approvalMeta.set(approvalId, { callId, tool })
    updateTask(task.id, { status: 'awaiting-approval' })
    // Backward-compat channel kept alongside the unified stream.
    emit('approval:request', request)
    emitEvent({
      kind: 'approval-request',
      approvalId,
      callId,
      tool,
      riskTier: task.riskTier,
      action: task.title,
      diffPreview,
      status: 'pending'
    })
  }

  const finishTask = (taskId: string, callId: string, tool: string): void => {
    const title = state.tasks.find((t) => t.id === taskId)?.title ?? taskId
    updateTask(taskId, { status: 'done' })
    emitEvent({ kind: 'tool-result', callId, tool, ok: true, summary: `Completed: ${title}` })
    const finding: Finding = {
      id: newId('finding'),
      title: `Checked: ${title}`,
      severity: 'info',
      taskId
    }
    emit('finding:new', finding)
    advance()
  }

  // Shared resolver for both the §6.1 `respondApproval` channel and the legacy
  // `approval:respond` channel. Folds the decision back into the transcript by
  // re-emitting the approval event with a resolved status (arch.md §6.1).
  const resolveApproval = ({ approvalId, decision, editedParams }: ApprovalDecision): void => {
    const request = pendingApprovals.get(approvalId)
    if (!request) return
    const meta = approvalMeta.get(approvalId)
    pendingApprovals.delete(approvalId)
    approvalMeta.delete(approvalId)
    const callId = meta?.callId ?? newId('call')
    const tool = meta?.tool ?? 'tool'
    // If the human edited params, surface the edited values as the resolved preview.
    const diffPreview = editedParams
      ? Object.entries(editedParams)
          .map(([key, value]) => `${key}=${value}`)
          .join(' · ')
      : request.diffPreview

    if (decision === 'approve') {
      emitEvent({
        kind: 'approval-request',
        approvalId,
        callId,
        tool,
        riskTier: request.riskTier,
        action: request.action,
        diffPreview,
        status: 'approved'
      })
      finishTask(request.taskId, callId, tool)
    } else {
      emitEvent({
        kind: 'approval-request',
        approvalId,
        callId,
        tool,
        riskTier: request.riskTier,
        action: request.action,
        diffPreview,
        status: 'denied'
      })
      emitEvent({ kind: 'tool-result', callId, tool, ok: false, summary: `Denied: ${request.action}` })
      updateTask(request.taskId, { status: 'denied' })
      advance()
    }
  }

  function handle<T>(channel: string, fn: (payload: T) => unknown): void {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, payload: T) => {
      if (event.sender !== win.webContents) return null
      return fn(payload)
    })
  }

  handle<StartAgentParams>('agent:start', ({ goal, scope }) => {
    state = {
      runId: newId('run'),
      state: 'running',
      goal,
      scope,
      tasks: [
        { id: newId('task'), title: `Recon: map ${scope}`, riskTier: 'read-only', status: 'pending' },
        {
          id: newId('task'),
          title: `Check CSRF protection on ${scope}`,
          riskTier: 'read-only',
          status: 'pending'
        },
        {
          id: newId('task'),
          title: `Probe XSS on forms in ${scope}`,
          riskTier: 'mutating',
          status: 'pending'
        }
      ]
    }
    emitSession()
    emit('plan:update', state.tasks)
    // Echo the engagement goal into the transcript, then let the mock planner run.
    emitEvent({ kind: 'user-message', text: `Goal: ${goal} (scope: ${scope})`, context: [] })
    emitEvent({ kind: 'reasoning', text: `Starting engagement. Planning tasks for ${scope}.` })
    advance()
    return state
  })

  // §6.1 `sendMessage {text}`: append a user-message event and trigger a MOCK agent
  // reply (reasoning + a read-only tool-call + its result). No network / OpenCode.
  const onSendMessage = ({ text }: SendMessageParams): null => {
    emitEvent({ kind: 'user-message', text, context: [] })
    const callId = newId('call')
    emitEvent({ kind: 'reasoning', text: `Looking into: ${text}` })
    emitEvent({
      kind: 'tool-call',
      callId,
      tool: 'csrf-token-checker',
      riskTier: 'read-only',
      args: { query: text }
    })
    emitEvent({
      kind: 'tool-result',
      callId,
      tool: 'csrf-token-checker',
      ok: true,
      summary: `No state-changing request related to "${text}" is missing a CSRF token.`
    })
    return null
  }
  handle<SendMessageParams>('sendMessage', onSendMessage)

  handle<void>('agent:pause', () => setRunState('paused'))
  handle<void>('agent:resume', () => {
    if (state.state === 'paused') {
      setRunState('running')
      advance()
    }
  })

  // §6.1 `respondApproval {approvalId, decision, editedParams?}`, plus the legacy
  // `approval:respond` channel kept working for backward-compat.
  handle<ApprovalDecision>('respondApproval', resolveApproval)
  handle<ApprovalDecision>('approval:respond', resolveApproval)

  handle<void>('tool:list', () => STUB_TOOLS)
  handle<void>('agent:get-state', () => state)

  win.on('closed', () => {
    for (const channel of [
      'agent:start',
      'agent:pause',
      'agent:resume',
      'sendMessage',
      'respondApproval',
      'approval:respond',
      'tool:list',
      'agent:get-state'
    ]) {
      ipcMain.removeHandler(channel)
    }
  })

  return { getState: () => state }
}
