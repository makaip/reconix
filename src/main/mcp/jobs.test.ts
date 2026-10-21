// JobStore is the contract the renderer polls and the runner aborts through, so
// its lifecycle is pinned here: queued → running → settled, cancel as a real
// abort (not a status flag), and cancellation winning any settle race.
import { describe, expect, it } from 'vitest'
import { createJobStore, type JobHandle } from './jobs'
import { ToolInputError } from './errors'

/** Yields to the event loop so a setImmediate-scheduled transition can run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for job state')
    await tick()
  }
}

describe('createJobStore', () => {
  it('runs a job from queued to completed and exposes its output', async () => {
    const store = createJobStore()
    const job = await store.start('nmap_scan', 'example.com', async () => ({ hosts: 2 }))

    // start() resolves in the promised 'queued' state; the runner hasn't run yet.
    expect(job.status).toBe('queued')
    expect(job.startedAt).toBeNull()
    expect(job.finishedAt).toBeNull()
    expect(job.target).toBe('example.com')

    await waitFor(() => store.status(job.id)?.status === 'completed')

    const state = store.status(job.id)!
    expect(state.status).toBe('completed')
    expect(state.startedAt).toBeTypeOf('number')
    expect(state.finishedAt).toBeTypeOf('number')
    expect(state.finishedAt!).toBeGreaterThanOrEqual(state.startedAt!)
    expect(state.error).toBeUndefined()

    await expect(store.result(job.id)).resolves.toEqual({
      status: 'completed',
      output: { hosts: 2 }
    })
  })

  it('records a rejection as a failed job with the error message', async () => {
    const store = createJobStore()
    const job = await store.start('nuclei_scan', undefined, async () => {
      throw new Error('nuclei exited 2')
    })

    await waitFor(() => store.status(job.id)?.status === 'failed')

    const state = store.status(job.id)!
    expect(state.error).toBe('nuclei exited 2')
    expect(state.finishedAt).toBeTypeOf('number')
    await expect(store.result(job.id)).resolves.toMatchObject({
      status: 'failed',
      error: 'nuclei exited 2'
    })
  })

  it('cancels a running job and ignores the runner’s late resolution', async () => {
    const store = createJobStore()
    let release!: () => void
    const job = await store.start(
      'ffuf_fuzz',
      undefined,
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    await waitFor(() => store.status(job.id)?.status === 'running')
    await expect(store.cancel(job.id)).resolves.toBe(true)

    const cancelled = store.status(job.id)!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.finishedAt).toBeTypeOf('number')

    // The runner finishing afterwards must not flip the job back to completed.
    release()
    await tick()
    await tick()
    expect(store.status(job.id)!.status).toBe('cancelled')
  })

  it('returns false when cancelling an already-completed job', async () => {
    const store = createJobStore()
    const job = await store.start('get_page_info', undefined, async () => 'ok')
    await waitFor(() => store.status(job.id)?.status === 'completed')

    await expect(store.cancel(job.id)).resolves.toBe(false)
    expect(store.status(job.id)!.status).toBe('completed')
  })

  it('returns false when cancelling an unknown job', async () => {
    const store = createJobStore()
    await expect(store.cancel('job_nope')).resolves.toBe(false)
  })

  it('throws ToolInputError for the result of an unknown job', async () => {
    const store = createJobStore()
    await expect(store.result('job_nope')).rejects.toBeInstanceOf(ToolInputError)
    await expect(store.result('job_nope')).rejects.toThrow('unknown job')
  })

  it('lists jobs newest-first', async () => {
    const store = createJobStore()
    const a = await store.start('a', undefined, async () => 1)
    const b = await store.start('b', undefined, async () => 2)
    const c = await store.start('c', undefined, async () => 3)

    const ids = store.list().map((job) => job.id)
    expect(ids).toEqual([c.id, b.id, a.id])
  })

  it('aborts the handle signal so a real runner can stop', async () => {
    const store = createJobStore()
    let sawAbort = false
    let handleRef: JobHandle | undefined

    // A runner that only ever ends when its signal fires — the shape runTool
    // will have, where the abort kills the spawned process tree.
    const job = await store.start(
      'subfinder_enum',
      undefined,
      (handle) =>
        new Promise((resolve) => {
          handleRef = handle
          handle.signal.addEventListener('abort', () => {
            sawAbort = true
            resolve('stopped early')
          })
        })
    )

    await waitFor(() => store.status(job.id)?.status === 'running')
    expect(handleRef?.aborted).toBe(false)

    await expect(store.cancel(job.id)).resolves.toBe(true)
    await tick()

    expect(handleRef!.aborted).toBe(true)
    expect(handleRef!.signal.aborted).toBe(true)
    expect(sawAbort).toBe(true)
    // Resolving inside the abort listener must NOT count as a completion.
    expect(store.status(job.id)!.status).toBe('cancelled')
    expect(store.status(job.id)!.result).toBeUndefined()
  })

  it('does not start a job cancelled while still queued', async () => {
    const store = createJobStore()
    let ran = false
    const job = await store.start('nmap_scan', undefined, async () => {
      ran = true
    })

    // Cancel before the setImmediate transition fires.
    await expect(store.cancel(job.id)).resolves.toBe(true)
    await tick()
    await tick()

    expect(ran).toBe(false)
    expect(store.status(job.id)!.status).toBe('cancelled')
    expect(store.status(job.id)!.startedAt).toBeNull()
  })
})
