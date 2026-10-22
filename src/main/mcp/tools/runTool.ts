// Shared argv-only external-binary runner (ARCHITECTURE §8 item 6).
//
// Every CLI wrapper (run_tool, nuclei_scan, ffuf_fuzz, nmap_scan,
// subfinder_enum) used to carry its own near-identical spawn/kill/capture
// plumbing. This module is the single implementation of the safety rules:
//
//   • argv-only — `spawn(binary, args)` with `shell: false`, so no value can
//     ever be interpreted by a shell;
//   • process-tree kill on timeout — a POSIX child is spawned detached (own
//     process group) so a negative pid signals wrappers and grandchildren too;
//   • byte-capped capture, decoded once as UTF-8 after the run so the cap can
//     never split a multi-byte sequence into mojibake;
//   • a wall-clock cap that resolves with the partial capture instead of
//     hanging the MCP call when a grandchild keeps the pipes open.
import { spawn, type ChildProcess } from 'node:child_process'
import { ToolExecError } from '../errors'

/** Default wall-clock cap for a brokered binary (60s). */
export const RUN_TOOL_TIMEOUT_MS = 60_000
/** Default per-stream capture cap (1 MB). */
export const RUN_TOOL_MAX_OUTPUT = 1_000_000
/** Grace period after the kill signal for the pipes to drain. */
const KILL_GRACE_MS = 1_000

export interface RunToolResult {
  /** Exit code, or null when the child was killed by a signal / never closed. */
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  /** True when the wall-clock cap fired and the process tree was killed. */
  timedOut: boolean
}

export interface RunToolOptions {
  /** Wall-clock cap in ms. Defaults to RUN_TOOL_TIMEOUT_MS. */
  timeoutMs?: number
  /**
   * Per-stream capture cap in bytes. Defaults to RUN_TOOL_MAX_OUTPUT. Tools
   * that legitimately emit megabytes (nmap XML, nuclei JSONL, ffuf NDJSON)
   * raise it; the cap is still a hard memory bound.
   */
  maxOutputBytes?: number
  /**
   * Cancellation channel. When aborted the process tree is killed and the run
   * REJECTS with RunToolAbortError — abort means cancel, never "return the
   * partial output", because a caller that stopped a scan must not be handed
   * results it may then act on as if the scan had finished.
   */
  signal?: AbortSignal
}

/**
 * Raised when a run was cancelled through its AbortSignal. Carries code
 * 'ABORTED' so the pipeline's audit row and the agent both see a cancellation
 * rather than a generic execution failure.
 */
export class RunToolAbortError extends Error {
  readonly code = 'ABORTED'
  readonly retriable = false
  constructor(message = 'job aborted') {
    super(message)
    this.name = 'RunToolAbortError'
  }
}

/**
 * Raised when the binary could not be started (missing, not executable, ...).
 * `spawnCode` carries the Node errno (`ENOENT`, `EACCES`, ...) so each wrapper
 * can keep its own actionable "how to install it" message.
 */
export class RunToolSpawnError extends ToolExecError {
  constructor(
    readonly binary: string,
    readonly spawnCode: string | undefined,
    message: string
  ) {
    super(message)
    this.name = 'RunToolSpawnError'
  }
}

/**
 * Kills the whole process tree. A bare child.kill() only signals the direct
 * child, so a wrapper script (nmap -> sh -> helper, any `sh -c`) leaves
 * grandchildren running past the timeout. On POSIX the child is spawned
 * detached, which makes it a process-group leader, so a negative pid signals
 * the group; on Windows taskkill /T walks the tree.
 */
export function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      }).on('error', () => {
        // Nothing left to kill with; the run is already being abandoned.
      })
    } catch {
      /* already gone */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

interface CappedStream {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

function appendCapped(stream: CappedStream, chunk: Buffer, cap: number): void {
  if (stream.bytes >= cap) {
    // Output past the cap still counts as truncation even when the tail is empty.
    if (chunk.length > 0) stream.truncated = true
    return
  }
  const take = Math.min(chunk.length, cap - stream.bytes)
  if (take < chunk.length) stream.truncated = true
  if (take > 0) {
    stream.chunks.push(chunk.subarray(0, take))
    stream.bytes += take
  }
}

/**
 * Runs `binary` with `args` argv-only (no shell) and a hard wall-clock cap.
 * Resolves with whatever was captured even when the run times out, so a long
 * scan still yields the findings it produced before the kill.
 *
 * Rejects with RunToolSpawnError when the process could not be started at all.
 */
export function runTool(
  binary: string,
  args: readonly string[] = [],
  opts: RunToolOptions = {}
): Promise<RunToolResult> {
  const timeoutMs = opts.timeoutMs ?? RUN_TOOL_TIMEOUT_MS
  const maxOutputBytes = opts.maxOutputBytes ?? RUN_TOOL_MAX_OUTPUT
  const signal = opts.signal

  // Already aborted before we spawned anything: nothing to kill, so don't
  // create a process at all.
  if (signal?.aborted) {
    return Promise.reject(new RunToolAbortError('job aborted'))
  }

  return new Promise<RunToolResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(binary, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: own process group so the timeout can signal the whole tree.
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      reject(new RunToolSpawnError(binary, e.code, `failed to spawn "${binary}": ${e.message}`))
      return
    }

    const stdout: CappedStream = { chunks: [], bytes: 0, truncated: false }
    const stderr: CappedStream = { chunks: [], bytes: 0, truncated: false }
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (grace) clearTimeout(grace)
      signal?.removeEventListener('abort', onAbort)
    }

    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      killProcessTree(child.pid)
      reject(new RunToolAbortError('job aborted by user'))
    }

    // Arm cancellation before the child can emit anything. `once` plus the
    // post-add check covers an abort that lands between the guard above and
    // this registration.
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      // Decode once, after all chunks are in: per-chunk slicing split
      // multi-byte UTF-8 sequences at the cap and produced mojibake.
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut
      })
    }

    timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid)
      // A grandchild holding the pipes open can delay 'close' forever; report
      // what we captured rather than leaving the MCP call hanging.
      grace = setTimeout(() => finish(null), KILL_GRACE_MS)
      grace.unref?.()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => appendCapped(stdout, chunk, maxOutputBytes))
    child.stderr?.on('data', (chunk: Buffer) => appendCapped(stderr, chunk, maxOutputBytes))

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new RunToolSpawnError(binary, err.code, `failed to spawn "${binary}": ${err.message}`))
    })
    child.on('close', (code) => finish(code))
  })
}
