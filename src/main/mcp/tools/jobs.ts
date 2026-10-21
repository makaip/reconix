// Background jobs (API.md §3 — orchestration). Long scanner runs (nuclei, ffuf,
// nmap, subfinder, run_tool) would otherwise block the orchestrator for the
// whole run; these tools hand back a jobId immediately and let the agent poll
// instead. Two rules keep this cheap and safe:
//   1. Only background-capable tools may be started — an allow-list, not a
//      caller-supplied promise. Anything else is a ToolInputError.
//   2. start_background_job declares `target()` so the pipeline scope-checks the
//      named target BEFORE the job is enqueued (pipeline.ts step 3). A job can
//      never be spawned against an out-of-scope host.
// State lives in the single `jobStore` instance exported by ../jobs: the same
// one copilot.ts's IPC surface reads, so the UI and the agent watch one list.
import { defineTool, type Tool } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'
import { str } from '../validate'
import { jobStore } from '../jobs'

// Job/JobResult are derived from the store contract rather than imported as
// named types, so this module stays in step with ../jobs without duplicating
// its shapes.
type Job = NonNullable<ReturnType<typeof jobStore.status>>
type JobResult = Awaited<ReturnType<typeof jobStore.result>>
type JobList = ReturnType<typeof jobStore.list>

/**
 * Tools that are genuinely long-running and safe to detach. Kept in sync with
 * the "Only background-capable tools are allowed" description — anything that
 * mutates browser state (navigate/click/fill) must stay synchronous so the
 * agent observes the resulting DOM.
 */
const BACKGROUND_CAPABLE = new Set([
  'nuclei_scan',
  'ffuf_fuzz',
  'nmap_scan',
  'subfinder_enum',
  'run_tool'
])

const MAX_JOB_ID_LENGTH = 128
const MAX_TARGET_LENGTH = 2048

export interface StartBackgroundJobInput {
  tool: string
  args?: Record<string, unknown>
  target?: string
}

export interface StartBackgroundJobOutput {
  jobId: string
  status: string
  target?: string
}

export interface JobIdInput {
  jobId: string
}

export interface CancelBackgroundJobOutput {
  cancelled: boolean
}

/** Optional plain-object args; arrays/null/primitives are rejected here so the
 *  underlying tool never receives a body it can't spread. */
function optionalArgs(raw: unknown): Record<string, unknown> | undefined {
  const v = (raw as Record<string, unknown>).args
  if (v === undefined) return undefined
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ToolInputError('"args" must be an object of tool parameters')
  }
  return v as Record<string, unknown>
}

/** Optional scope-checkable target (URL or host). Trimmed; never coerced. */
function optionalTarget(raw: unknown): string | undefined {
  const v = (raw as Record<string, unknown>).target
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new ToolInputError('"target" must be a string')
  const trimmed = v.trim()
  if (trimmed.length === 0) throw new ToolInputError('"target" must be a non-empty string')
  if (trimmed.length > MAX_TARGET_LENGTH) {
    throw new ToolInputError(`"target" must be at most ${MAX_TARGET_LENGTH} characters`)
  }
  return trimmed
}

function jobIdInput(raw: unknown): JobIdInput {
  return { jobId: str(raw, 'jobId', MAX_JOB_ID_LENGTH) }
}

function unknownJob(jobId: string): ToolInputError {
  return new ToolInputError(`unknown job: ${jobId} (use list_background_jobs to see live ids)`)
}

// Shared wire shape for a Job, reused by get_job_status and list_background_jobs.
const JOB_SCHEMA = {
  type: 'object',
  required: ['id', 'tool', 'status', 'startedAt'],
  properties: {
    id: { type: 'string' },
    tool: { type: 'string' },
    target: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
    // Null until the job is picked up (startedAt) / settles (finishedAt).
    startedAt: { type: ['number', 'null'] },
    finishedAt: { type: ['number', 'null'] },
    progress: {},
    result: {},
    error: { type: 'string' }
  }
} as const

// ── start_background_job ──────────────────────────────────────────────────────
const start_background_job = defineTool<StartBackgroundJobInput, StartBackgroundJobOutput>({
  name: 'start_background_job',
  description:
    'Start a long-running tool (nuclei_scan, ffuf_fuzz, nmap_scan, subfinder_enum, run_tool) in the background and return a jobId immediately. The orchestrator can keep working while the job runs; poll get_job_status and pull results with get_job_result. Only background-capable tools are allowed.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['tool'],
    properties: {
      tool: {
        type: 'string',
        enum: [...BACKGROUND_CAPABLE],
        description: 'Background-capable tool to run.'
      },
      args: {
        type: 'object',
        description: 'Parameters forwarded to the underlying tool, exactly as its own input schema expects.'
      },
      target: {
        type: 'string',
        maxLength: MAX_TARGET_LENGTH,
        description: 'URL or host the job runs against; scope-checked before the job starts.'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    required: ['jobId', 'status'],
    properties: {
      jobId: { type: 'string' },
      status: { type: 'string' },
      target: { type: 'string' }
    }
  },
  parse: (raw) => {
    const tool = str(raw, 'tool', 64)
    if (!BACKGROUND_CAPABLE.has(tool)) {
      throw new ToolInputError(
        `"tool" must be a background-capable tool (${[...BACKGROUND_CAPABLE].join(', ')}); "${tool}" must be called directly`
      )
    }
    return { tool, args: optionalArgs(raw), target: optionalTarget(raw) }
  },
  // Returning the target opts this call into the pipeline's scope gate, so an
  // out-of-scope host is denied before the runner is ever started.
  target: (i) => i.target,
  execute: async (i, ctx): Promise<StartBackgroundJobOutput> => {
    const invoke = ctx.invokeTool
    if (!invoke) {
      throw new ToolExecError(
        'background jobs are unavailable on this surface: no in-process tool invoker is wired'
      )
    }

    const job = await jobStore.start(i.tool, i.target, async () => {
      // `background` is stripped: a detached job must not ask the underlying
      // tool to detach again (that would return a jobId-shaped body the store
      // would record as a result).
      const params = { ...(i.args ?? {}), background: undefined } as Record<string, unknown>
      const res = await invoke(i.tool, params)
      // A tool that was denied or errored comes back as { ok:false } rather
      // than throwing. Reject so the job settles 'failed' with the reason,
      // instead of 'completed' with nothing to show for it.
      if (!res.ok) {
        throw new ToolExecError(res.error ?? `${i.tool} failed without an error message`)
      }
      return res.output
    })

    return { jobId: job.id, status: job.status, target: i.target }
  }
})

// ── get_job_status ────────────────────────────────────────────────────────────
const get_job_status = defineTool<JobIdInput, Job>({
  name: 'get_job_status',
  description:
    'Report one background job: status (queued/running/completed/failed/cancelled), timestamps, progress and a short error when it failed. Cheap — poll this instead of re-running a scan.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['jobId'],
    properties: {
      jobId: { type: 'string', maxLength: MAX_JOB_ID_LENGTH }
    },
    additionalProperties: false
  },
  outputSchema: JOB_SCHEMA,
  parse: jobIdInput,
  execute: async (i) => {
    const job = jobStore.status(i.jobId)
    if (!job) throw unknownJob(i.jobId)
    return job
  }
})

// ── get_job_result ────────────────────────────────────────────────────────────
const get_job_result = defineTool<JobIdInput, JobResult>({
  name: 'get_job_result',
  description:
    'Pull a background job’s result: { status, output?, error? }. Output is present once the job completed; error explains a failed or cancelled run. Call get_job_status first when you only need to know whether it is done.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['jobId'],
    properties: {
      jobId: { type: 'string', maxLength: MAX_JOB_ID_LENGTH }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string' },
      output: {},
      error: { type: 'string' }
    }
  },
  parse: jobIdInput,
  execute: async (i) => {
    // Check first so an unknown id is always a ToolInputError, whatever the
    // store's own result() contract does for a missing job.
    if (!jobStore.status(i.jobId)) throw unknownJob(i.jobId)
    return jobStore.result(i.jobId)
  }
})

// ── cancel_background_job ─────────────────────────────────────────────────────
const cancel_background_job = defineTool<JobIdInput, CancelBackgroundJobOutput>({
  name: 'cancel_background_job',
  description:
    'Cancel a running background job. Returns { cancelled } — false when the job already finished (or was cancelled) and there was nothing left to stop.',
  riskTier: 'M',
  inputSchema: {
    type: 'object',
    required: ['jobId'],
    properties: {
      jobId: { type: 'string', maxLength: MAX_JOB_ID_LENGTH }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    required: ['cancelled'],
    properties: { cancelled: { type: 'boolean' } }
  },
  parse: jobIdInput,
  execute: async (i) => ({ cancelled: await jobStore.cancel(i.jobId) })
})

// ── list_background_jobs ──────────────────────────────────────────────────────
const list_background_jobs = defineTool<Record<string, never>, JobList>({
  name: 'list_background_jobs',
  description:
    'List every background job started in this session with its status and timestamps — use it to find a jobId you did not keep, or to see what is still running before starting more work.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'array', items: JOB_SCHEMA },
  parse: () => ({}) as Record<string, never>,
  execute: async () => jobStore.list()
})

export const jobsTools: Tool[] = [
  start_background_job as Tool,
  get_job_status as Tool,
  get_job_result as Tool,
  cancel_background_job as Tool,
  list_background_jobs as Tool
]
