// Background job store (ARCHITECTURE §8.6 / §6.2).
//
// A long-running tool (an nmap sweep, a nuclei run, a crawl) must not block the
// agent's MCP call for minutes. The store turns such a call into a Job with an
// identity the renderer can poll: queued → running → completed/failed, with a
// cancel path that is a real abort (an AbortSignal the runner listens to), not
// a status flag that leaves the work running behind the scenes.
//
// The store owns scheduling and lifecycle ONLY. It never knows what a tool is
// or how to run it — `start()` takes a runner closure, so jobs stay testable
// and the store never imports the registry (no cycle: registry → tool → jobs).

import { ToolInputError } from './errors'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** What a caller can observe about a job. `result`/`error` are only meaningful
 *  once the job has settled; `progress` is advisory. */
export interface Job {
  id: string
  tool: string
  target?: string
  status: JobStatus
  startedAt: number | null
  finishedAt: number | null
  progress?: { current: number; max?: number }
  result?: unknown
  error?: string
}

/** The cancellation channel handed to a runner. `signal` is the same signal
 *  runTool() accepts, so aborting a job kills the spawned process tree instead
 *  of orphaning it. */
export interface JobHandle {
  readonly signal: AbortSignal
  aborted: boolean
  abort(): void
}

export interface JobStore {
  /** Registers a job and lets it start on the next tick. Resolves with the job
   *  in its 'queued' state — poll status()/result() for the outcome. */
  start(
    tool: string,
    target: string | undefined,
    runner: (handle: JobHandle) => Promise<unknown>
  ): Promise<Job>
  status(jobId: string): Job | undefined
  result(jobId: string): Promise<{ status: string; output?: unknown; error?: string }>
  /** Aborts a queued/running job. Returns false when there was nothing to stop
   *  (unknown id, or already completed/failed/cancelled) — never an error: a
   *  cancel racing a completion is normal, not a failure. */
  cancel(jobId: string): Promise<boolean>
  /** All jobs, newest first. */
  list(): Job[]
}

interface InternalJob {
  id: string
  /** Monotonic per-store sequence — the tiebreak when two jobs share a ms. */
  seq: number
  tool: string
  target?: string
  status: JobStatus
  startedAt: number | null
  finishedAt: number | null
  progress?: { current: number; max?: number }
  result?: unknown
  error?: string
  handle: JobHandle
  runner: (handle: JobHandle) => Promise<unknown>
}

/** Copies the public shape so callers can't mutate store state through the
 *  object they get back (and can't see `handle`/`runner`). */
function snapshot(job: InternalJob): Job {
  return {
    id: job.id,
    tool: job.tool,
    target: job.target,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress ? { ...job.progress } : undefined,
    result: job.result,
    error: job.error
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function createJobStore(): JobStore {
  const jobs = new Map<string, InternalJob>()
  let seq = 0

  /** Runs the job once, off the current tick. A job cancelled while still
   *  queued is never started at all — aborting a job that hasn't begun should
   *  not spawn the process just to kill it. */
  function begin(job: InternalJob): void {
    if (job.status !== 'queued') return
    job.status = 'running'
    job.startedAt = Date.now()

    // A runner may throw synchronously; normalising through Promise.resolve
    // keeps that on the same rejection path as an async failure.
    void Promise.resolve()
      .then(() => job.runner(job.handle))
      .then(
        (value) => {
          // A cancel wins the race: the runner's late resolution must not
          // resurrect a job the user already stopped.
          if (job.status === 'cancelled') return
          job.status = 'completed'
          job.result = value
          job.finishedAt = Date.now()
        },
        (err: unknown) => {
          if (job.status === 'cancelled') return
          job.status = 'failed'
          job.error = errorMessage(err)
          job.finishedAt = Date.now()
        }
      )
  }

  return {
    async start(tool, target, runner) {
      const n = ++seq
      const controller = new AbortController()
      const handle: JobHandle = {
        signal: controller.signal,
        get aborted() {
          return controller.signal.aborted
        },
        abort() {
          controller.abort()
        }
      }
      const job: InternalJob = {
        id: `job_${n}`,
        seq: n,
        tool,
        target,
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        handle,
        runner
      }
      jobs.set(job.id, job)
      // setImmediate, not a microtask: start() must return the 'queued' state
      // the caller was promised, and the runner must not begin inside the
      // caller's IPC handler frame.
      setImmediate(() => begin(job))
      return snapshot(job)
    },

    status(jobId) {
      const job = jobs.get(jobId)
      return job ? snapshot(job) : undefined
    },

    async result(jobId) {
      const job = jobs.get(jobId)
      if (!job) throw new ToolInputError('unknown job')
      // Snapshot of the outcome at call time. A still-running job answers
      // 'running' with no output — polling is the caller's contract.
      return { status: job.status, output: job.result, error: job.error }
    },

    async cancel(jobId) {
      const job = jobs.get(jobId)
      if (!job) return false
      if (job.status !== 'queued' && job.status !== 'running') return false
      // Abort first: the signal listener in runTool kills the process tree.
      job.handle.abort()
      job.status = 'cancelled'
      job.finishedAt = Date.now()
      return true
    },

    list() {
      return [...jobs.values()]
        .sort((a, b) => {
          const at = a.startedAt ?? 0
          const bt = b.startedAt ?? 0
          if (bt !== at) return bt - at
          return b.seq - a.seq
        })
        .map(snapshot)
    }
  }
}

/**
 * The process-wide store. Both surfaces must watch the SAME jobs: the agent's
 * background tools (mcp/tools/jobs.ts) enqueue into it and copilot.ts's
 * jobs:* IPC handlers read it, so a scan the agent started is visible in the
 * UI and cancellable from there. Tests use createJobStore() for isolation.
 */
export const jobStore: JobStore = createJobStore()
