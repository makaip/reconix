import { BrowserWindow, ipcMain } from 'electron'
import type {
  AgentSessionState,
  AgentTask,
  ApprovalDecision,
  ApprovalRequest,
  Finding,
  RunState,
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

/**
 * Owns the current engagement: run state, task graph, and the approval queue
 * (arch.md §3.3). This is a stand-in for the real OpenCode-driven planner (§3.4) —
 * `agent:start` seeds a fixed task graph instead of calling out to a planner, so the
 * IPC contract (§5) and the approval gate (§6.4) can be built and exercised before
 * that integration lands.
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

  const emit = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
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

  // Runs the next pending task: read-only tasks auto-execute, anything else is gated
  // behind an approval request (arch.md §6.4).
  const advance = (): void => {
    if (state.state !== 'running') return
    const task = state.tasks.find((t) => t.status === 'pending')
    if (!task) {
      setRunState('idle')
      return
    }
    if (task.riskTier === 'read-only') {
      updateTask(task.id, { status: 'running' })
      finishTask(task.id)
      return
    }
    const approvalId = newId('approval')
    const request: ApprovalRequest = {
      approvalId,
      taskId: task.id,
      action: task.title,
      riskTier: task.riskTier,
      diffPreview: `Run "${task.title}" (${task.riskTier})`
    }
    pendingApprovals.set(approvalId, request)
    updateTask(task.id, { status: 'awaiting-approval' })
    emit('approval:request', request)
  }

  const finishTask = (taskId: string): void => {
    const title = state.tasks.find((t) => t.id === taskId)?.title ?? taskId
    updateTask(taskId, { status: 'done' })
    const finding: Finding = {
      id: newId('finding'),
      title: `Checked: ${title}`,
      severity: 'info',
      taskId
    }
    emit('finding:new', finding)
    advance()
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
    advance()
    return state
  })

  handle<void>('agent:pause', () => setRunState('paused'))
  handle<void>('agent:resume', () => {
    if (state.state === 'paused') {
      setRunState('running')
      advance()
    }
  })

  handle<ApprovalDecision>('approval:respond', ({ approvalId, decision }) => {
    const request = pendingApprovals.get(approvalId)
    if (!request) return
    pendingApprovals.delete(approvalId)
    if (decision === 'approve') {
      finishTask(request.taskId)
    } else {
      updateTask(request.taskId, { status: 'denied' })
      advance()
    }
  })

  handle<void>('tool:list', () => STUB_TOOLS)
  handle<void>('agent:get-state', () => state)

  win.on('closed', () => {
    for (const channel of [
      'agent:start',
      'agent:pause',
      'agent:resume',
      'approval:respond',
      'tool:list',
      'agent:get-state'
    ]) {
      ipcMain.removeHandler(channel)
    }
  })

  return { getState: () => state }
}
