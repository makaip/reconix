// runTool is the single spawn/kill/capture path behind every CLI wrapper, so
// its contract is pinned here: argv-only execution, stream separation, byte
// caps, UTF-8 decoding, process-tree kill on timeout, and spawn errors.
import { describe, expect, it } from 'vitest'
import {
  RUN_TOOL_MAX_OUTPUT,
  RUN_TOOL_TIMEOUT_MS,
  RunToolSpawnError,
  killProcessTree,
  runTool
} from './runTool'

const node = process.execPath

describe('runTool', () => {
  it('captures stdout, stderr and the exit code separately', async () => {
    const run = await runTool(node, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"
    ])
    expect(run).toEqual({
      exitCode: 3,
      stdout: 'out',
      stderr: 'err',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false
    })
  })

  it('caps each stream and flags truncation independently', async () => {
    const run = await runTool(
      node,
      ['-e', "process.stdout.write('x'.repeat(5000)); process.stderr.write('y'.repeat(10))"],
      { maxOutputBytes: 100 }
    )
    expect(run.stdout).toHaveLength(100)
    expect(run.stdoutTruncated).toBe(true)
    expect(run.stderr).toBe('y'.repeat(10))
    expect(run.stderrTruncated).toBe(false)
  })

  it('kills the process tree on timeout and returns the partial capture', async () => {
    // 1s leaves room for node startup under a loaded parallel test run.
    const run = await runTool(
      node,
      ['-e', "process.stdout.write('partial'); setInterval(() => {}, 1000)"],
      { timeoutMs: 1_000 }
    )
    expect(run.timedOut).toBe(true)
    expect(run.exitCode).toBeNull()
    expect(run.stdout).toBe('partial')
  }, 15_000)

  it('rejects with a spawn error (and the errno) when the binary is missing', async () => {
    await expect(runTool('reconix-no-such-binary', [])).rejects.toBeInstanceOf(RunToolSpawnError)
    await expect(runTool('reconix-no-such-binary', [])).rejects.toMatchObject({ spawnCode: 'ENOENT' })
  })

  it('exports the documented defaults and tolerates a missing pid', () => {
    expect(RUN_TOOL_TIMEOUT_MS).toBe(60_000)
    expect(RUN_TOOL_MAX_OUTPUT).toBe(1_000_000)
    expect(() => killProcessTree(undefined)).not.toThrow()
  })
})
