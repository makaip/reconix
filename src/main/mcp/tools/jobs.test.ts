import { describe, expect, it, vi } from 'vitest'
import { ToolExecError, ToolInputError } from '../errors'
import type { ToolContext } from '../tool'
import { jobsTools } from './jobs'
import { allTools, mvpTools } from './index'

const tool = (name: string) => jobsTools.find((t) => t.name === name)!
const start = tool('start_background_job')
const getStatus = tool('get_job_status')
const getResult = tool('get_job_result')
const cancel = tool('cancel_background_job')
const list = tool('list_background_jobs')

/** Only `invokeTool` is touched by these tools; the rest of the context is the
 *  pipeline's business and is stubbed out. */
function ctxWith(
  invokeTool: (name: string, params: Record<string, unknown>) => Promise<unknown>
): ToolContext {
  return { invokeTool } as unknown as ToolContext
}
const noCtx = {} as ToolContext

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

interface JobLike {
  id: string
  tool: string
  target?: string
  status: string
  startedAt?: number
  finishedAt?: number
  error?: string
}

/** Jobs run detached, so tests poll for a terminal state rather than assuming
 *  start() is synchronous. Bounded so a stuck job fails the test, not the run. */
async function settled(jobId: string, timeoutMs = 3000): Promise<JobLike> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = (await getStatus.execute({ jobId }, noCtx)) as JobLike
    if (TERMINAL.has(job.status)) return job
    if (Date.now() > deadline) throw new Error(`job ${jobId} stuck in ${job.status}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('background-job registration', () => {
  it('registers all five tools in the catalog but not the MVP subset', () => {
    for (const name of [
      'start_background_job',
      'get_job_status',
      'get_job_result',
      'cancel_background_job',
      'list_background_jobs'
    ]) {
      expect(allTools.some((t) => t.name === name)).toBe(true)
      expect(mvpTools.some((t) => t.name === name)).toBe(false)
    }
  })

  it('gates starts and cancels at tier M, reads at tier R', () => {
    expect(start.riskTier).toBe('M')
    expect(cancel.riskTier).toBe('M')
    expect(getStatus.riskTier).toBe('R')
    expect(getResult.riskTier).toBe('R')
    expect(list.riskTier).toBe('R')
  })

  it('exposes the named target so the pipeline scope-checks before starting', () => {
    expect(start.target?.(start.parse({ tool: 'nuclei_scan', target: 'https://app.example.com' }))).toBe(
      'https://app.example.com'
    )
    expect(start.target?.(start.parse({ tool: 'nuclei_scan' }))).toBeUndefined()
  })
})

describe('start_background_job', () => {
  it('returns a jobId immediately and forwards args with "background" stripped', async () => {
    const invokeTool = vi.fn(async () => ({ ok: true, output: { found: 3 } }))
    const input = start.parse({
      tool: 'nuclei_scan',
      args: { target: 'https://app.example.com', background: true },
      target: 'https://app.example.com'
    })

    const res = (await start.execute(input, ctxWith(invokeTool))) as {
      jobId: string
      status: string
      target?: string
    }

    expect(typeof res.jobId).toBe('string')
    expect(res.jobId.length).toBeGreaterThan(0)
    expect(['queued', 'running', 'completed']).toContain(res.status)
    expect(res.target).toBe('https://app.example.com')

    const job = await settled(res.jobId)
    expect(job.tool).toBe('nuclei_scan')
    expect(job.target).toBe('https://app.example.com')

    const [calledTool, params] = invokeTool.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>
    ]
    expect(calledTool).toBe('nuclei_scan')
    expect(params.target).toBe('https://app.example.com')
    expect(params.background).toBeUndefined()
  })

  it('accepts every background-capable tool', () => {
    for (const name of ['nuclei_scan', 'ffuf_fuzz', 'nmap_scan', 'subfinder_enum', 'run_tool']) {
      expect(() => start.parse({ tool: name, args: {} })).not.toThrow()
    }
  })

  it('rejects tools that must stay synchronous', () => {
    expect(() => start.parse({ tool: 'navigate' })).toThrow(ToolInputError)
    expect(() => start.parse({ tool: 'click' })).toThrow(ToolInputError)
    expect(() => start.parse({ tool: '' })).toThrow(ToolInputError)
    expect(() => start.parse({})).toThrow(ToolInputError)
  })

  it('rejects malformed args and target values', () => {
    expect(() => start.parse({ tool: 'run_tool', args: ['ls'] })).toThrow(/args/)
    expect(() => start.parse({ tool: 'run_tool', args: null })).toThrow(/args/)
    expect(() => start.parse({ tool: 'run_tool', args: 'x' })).toThrow(/args/)
    expect(() => start.parse({ tool: 'run_tool', target: '' })).toThrow(/target/)
    expect(() => start.parse({ tool: 'run_tool', target: 42 })).toThrow(/target/)
  })

  it('refuses to start when no in-process invoker is wired', async () => {
    await expect(
      start.execute(start.parse({ tool: 'nmap_scan', target: 'example.com' }), noCtx)
    ).rejects.toThrow(ToolExecError)
  })
})

describe('get_job_status / get_job_result', () => {
  it('reports the job and its output once it completes', async () => {
    const invokeTool = vi.fn(async () => ({ ok: true, output: { hosts: ['a.example.com'] } }))
    const res = (await start.execute(
      start.parse({ tool: 'subfinder_enum', args: { domain: 'example.com' } }),
      ctxWith(invokeTool)
    )) as { jobId: string }

    const job = await settled(res.jobId)
    expect(job.id).toBe(res.jobId)
    expect(job.status).toBe('completed')

    const result = (await getResult.execute({ jobId: res.jobId }, noCtx)) as {
      status: string
      output?: unknown
    }
    expect(result.status).toBe('completed')
    expect(result.output).toEqual({ hosts: ['a.example.com'] })
  })

  it('surfaces a failed run as failed + error, not as a thrown tool error', async () => {
    const invokeTool = vi.fn(async () => {
      throw new Error('scanner exploded')
    })
    const res = (await start.execute(
      start.parse({ tool: 'ffuf_fuzz', args: { url: 'https://app.example.com/FUZZ' } }),
      ctxWith(invokeTool)
    )) as { jobId: string }

    const job = await settled(res.jobId)
    expect(job.status).toBe('failed')
    expect(job.error).toBeTruthy()

    const result = (await getResult.execute({ jobId: res.jobId }, noCtx)) as {
      status: string
      error?: string
    }
    expect(result.status).toBe('failed')
    expect(result.error).toBeTruthy()
  })

  it('turns a refused tool call (ok:false) into a failed job', async () => {
    const invokeTool = vi.fn(async () => ({
      ok: false,
      error: 'target out of scope — nuclei not started'
    }))
    const res = (await start.execute(
      start.parse({ tool: 'nuclei_scan', args: { target: 'https://out.example.com' } }),
      ctxWith(invokeTool)
    )) as { jobId: string }

    const job = await settled(res.jobId)
    expect(job.status).toBe('failed')
    expect(job.error).toContain('out of scope')
  })

  it('rejects unknown job ids with ToolInputError', async () => {
    await expect(getStatus.execute({ jobId: 'job_does_not_exist' }, noCtx)).rejects.toThrow(
      ToolInputError
    )
    await expect(getResult.execute({ jobId: 'job_does_not_exist' }, noCtx)).rejects.toThrow(
      /unknown job/
    )
  })
})

describe('cancel_background_job', () => {
  it('cancels a running job', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const invokeTool = vi.fn(async () => {
      await gate
      return { ok: true, output: 'late answer nobody wants' }
    })

    const res = (await start.execute(
      start.parse({ tool: 'nuclei_scan', args: { target: 'https://app.example.com' } }),
      ctxWith(invokeTool)
    )) as { jobId: string }

    const out = (await cancel.execute({ jobId: res.jobId }, noCtx)) as { cancelled: boolean }
    expect(out.cancelled).toBe(true)

    const job = (await getStatus.execute({ jobId: res.jobId }, noCtx)) as JobLike
    expect(job.status).toBe('cancelled')

    release() // let the detached runner unwind so it can't leak into later tests
  })

  it('answers cancelled:false for an unknown id instead of erroring', async () => {
    // cancel() is deliberately non-throwing (a cancel racing a completion is
    // normal), so an unknown id is a plain false rather than a ToolInputError.
    await expect(cancel.execute({ jobId: 'job_does_not_exist' }, noCtx)).resolves.toEqual({
      cancelled: false
    })
  })
})

describe('list_background_jobs', () => {
  it('includes a freshly started job', async () => {
    const invokeTool = vi.fn(async () => ({ ok: true, output: null }))
    const res = (await start.execute(
      start.parse({ tool: 'nmap_scan', args: { target: 'example.com' }, target: 'example.com' }),
      ctxWith(invokeTool)
    )) as { jobId: string }

    const jobs = (await list.execute({}, noCtx)) as JobLike[]
    expect(Array.isArray(jobs)).toBe(true)
    expect(jobs.some((j) => j.id === res.jobId)).toBe(true)
    await settled(res.jobId)
  })
})
