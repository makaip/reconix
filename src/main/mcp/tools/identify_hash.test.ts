// identify_hash: the sidecar still does the identification (its rules are
// verified by running the script), so these tests pin the MCP boundary instead —
// hostile input, exact argv, sidecar output passthrough, and every failure mode
// (missing interpreter, non-JSON stdout, non-zero exit).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Tool, ToolContext } from '../tool'
import {
  identifyHashTools,
  parseSidecarOutput,
  resolvePython,
  resolveScriptPath,
  type IdentifyHashInput,
  type IdentifyHashOutput
} from './identify_hash'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const execFileMock = vi.mocked(execFile)
const tool = identifyHashTools[0] as Tool<IdentifyHashInput, IdentifyHashOutput>

const ADVISORY =
  'Only crack hashes you own or are explicitly authorized to test. ' +
  'Unauthorized cracking may violate law and policy.'

const MD5 = '5f4dcc3b5aa765d61d8327deb882cf99'
const SHA256 = '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8'
const BCRYPT = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj4J/HS.iee2'

type ExecError = Error & { code?: string | number; killed?: boolean }
type ExecCallback = (err: ExecError | null, stdout?: string, stderr?: string) => void

/** Installs an execFile mock that hands the callback to `impl` (callback style). */
function mockExec(impl: (args: string[], cb: ExecCallback) => void): void {
  execFileMock.mockImplementation(((
    _file: string,
    args: string[],
    _opts: unknown,
    cb: ExecCallback
  ) => {
    impl(args, cb)
    return undefined as never
  }) as never)
}

function mockStdout(payload: unknown): void {
  mockExec((_args, cb) => cb(null, JSON.stringify(payload), ''))
}

/** Minimal context: only the trace sink is read by this tool. */
function makeCtx(traces?: { save: (kind: string, data: string) => Promise<string> }): ToolContext {
  return { ...(traces ? { traces } : {}) } as unknown as ToolContext
}

function md5Payload(): Record<string, unknown> {
  return {
    hash: MD5,
    length: 32,
    candidates: [
      { type: 'MD5', confidence: 0.95, pattern: '32 lowercase hex chars' },
      { type: 'NTLM', confidence: 0.8, pattern: '32 uppercase hex chars (input is lowercase)' }
    ],
    primaryType: 'MD5',
    crackStrategy: {
      tool: 'hashcat',
      mode: 0,
      johnFormat: 'raw-md5',
      wordlist: 'rockyou.txt',
      estimatedTime: 'very fast — tens to hundreds of billions/sec/GPU',
      notes: '32 hex is ambiguous with NTLM'
    },
    advisory: ADVISORY
  }
}

beforeEach(() => {
  execFileMock.mockReset()
})

describe('identify_hash input validation', () => {
  it('accepts a hash and trims nothing', () => {
    expect(tool.parse({ hash: MD5 })).toEqual({ hash: MD5 })
  })

  it('rejects an empty hash', () => {
    expect(() => tool.parse({ hash: '' })).toThrow(/"hash" must be a non-empty string/)
    expect(() => tool.parse({ hash: '   ' })).toThrow(/"hash" must be a non-empty string/)
  })

  it('rejects a non-string hash', () => {
    expect(() => tool.parse({ hash: 12345 })).toThrow(/"hash" must be a non-empty string/)
    expect(() => tool.parse({ hash: { $ne: null } })).toThrow(/"hash" must be a non-empty string/)
    expect(() => tool.parse({ hash: [MD5] })).toThrow(/"hash" must be a non-empty string/)
    expect(() => tool.parse(null)).toThrow(/expected an object/)
  })

  it('rejects a hash over 512 characters', () => {
    expect(() => tool.parse({ hash: 'a'.repeat(513) })).toThrow(/at most 512 characters/)
    expect(() => tool.parse({ hash: 'a'.repeat(512) })).not.toThrow()
  })

  it('rejects embedded whitespace (labels/line breaks are not part of a hash)', () => {
    expect(() => tool.parse({ hash: 'md5: 5f4dcc3b5aa765d61d8327deb882cf99' })).toThrow(/whitespace/)
    expect(() => tool.parse({ hash: `${MD5}\n${SHA256}` })).toThrow(/whitespace/)
  })

  it('declares no scope target — identification is local string analysis', () => {
    expect(tool.riskTier).toBe('R')
    expect(tool.target?.(tool.parse({ hash: MD5 }))).toBeUndefined()
  })

  it('resolves the real sidecar script and an existing interpreter on this checkout', () => {
    const script = resolveScriptPath()
    expect(script.replace(/\\/g, '/')).toMatch(/\.opencode\/tools\/identify_hash\.py$/)
    expect(existsSync(script)).toBe(true)
    expect(existsSync(resolvePython(script))).toBe(true)
  })
})

describe('identify_hash execute', () => {
  it('invokes the sidecar with argv-only --hash and returns the MD5 analysis', async () => {
    mockStdout(md5Payload())
    const save = vi.fn(async () => 'trace-abc123')

    const out = await tool.execute(tool.parse({ hash: MD5 }), makeCtx({ save }))

    // argv: [scriptPath, '--hash', value] — never a shell string.
    const [file, args] = execFileMock.mock.calls[0] as unknown as [string, string[]]
    expect(file).toMatch(/python/i)
    expect(args).toHaveLength(3)
    expect(args[0]).toMatch(/\.opencode\/tools\/identify_hash\.py$/)
    expect(args[1]).toBe('--hash')
    expect(args[2]).toBe(MD5)

    expect(out.hash).toBe(MD5)
    expect(out.length).toBe(32)
    expect(out.candidates.map((c) => c.type)).toEqual(['MD5', 'NTLM'])
    expect(out.primaryType).toBe('MD5')
    expect(out.crackStrategy).toMatchObject({ tool: 'hashcat', mode: 0, johnFormat: 'raw-md5' })
    expect(out.advisory).toBe(ADVISORY)
    expect(out.rawRef).toBe('trace-abc123')

    // The raw stdout is what gets traced, not a re-serialized object.
    expect(save).toHaveBeenCalledWith('trace', JSON.stringify(md5Payload()))
  })

  it('returns the SHA-256 strategy for a 64-hex hash', async () => {
    mockStdout({
      hash: SHA256,
      length: 64,
      candidates: [{ type: 'SHA-256', confidence: 0.98, pattern: '64 hex chars' }],
      primaryType: 'SHA-256',
      crackStrategy: {
        tool: 'hashcat',
        mode: 1400,
        johnFormat: 'raw-sha256',
        wordlist: 'rockyou.txt'
      },
      advisory: ADVISORY
    })

    const out = await tool.execute(tool.parse({ hash: SHA256 }), makeCtx())
    expect(out.primaryType).toBe('SHA-256')
    expect(out.crackStrategy?.mode).toBe(1400)
    expect(out.crackStrategy?.johnFormat).toBe('raw-sha256')
    expect(out.rawRef).toBeUndefined()
  })

  it('returns the bcrypt strategy and marks it dictionary-only', async () => {
    mockStdout({
      hash: BCRYPT,
      length: 60,
      candidates: [{ type: 'bcrypt', confidence: 0.99 }],
      primaryType: 'bcrypt',
      crackStrategy: { tool: 'hashcat', mode: 3200, johnFormat: 'bcrypt', notes: 'slow hash; brute-force infeasible, dictionary only' },
      advisory: ADVISORY
    })

    const out = await tool.execute(tool.parse({ hash: BCRYPT }), makeCtx())
    expect(out.primaryType).toBe('bcrypt')
    expect(out.crackStrategy?.mode).toBe(3200)
    expect(out.crackStrategy?.notes).toMatch(/dictionary only/)
  })

  it('reports an unrecognized hash as an empty candidate list, not an error', async () => {
    mockStdout({
      hash: 'not-a-hash!',
      length: 11,
      candidates: [],
      primaryType: null,
      crackStrategy: null,
      advisory: ADVISORY
    })

    const out = await tool.execute(tool.parse({ hash: 'not-a-hash!' }), makeCtx())
    expect(out.candidates).toEqual([])
    expect(out.primaryType).toBeUndefined()
    expect(out.crackStrategy).toBeUndefined()
    expect(out.advisory).toBe(ADVISORY)
  })

  it('skips rawRef when no trace store is wired', async () => {
    mockStdout(md5Payload())
    const out = await tool.execute(tool.parse({ hash: MD5 }), makeCtx())
    expect(out.rawRef).toBeUndefined()
    expect(out.primaryType).toBe('MD5')
  })
})

describe('identify_hash sidecar failures', () => {
  it('explains a missing Python interpreter (ENOENT) instead of leaking the spawn error', async () => {
    mockExec((_args, cb) => {
      const err = new Error('spawn python3 ENOENT') as ExecError
      err.code = 'ENOENT'
      cb(err, '', '')
    })

    const call = tool.execute(tool.parse({ hash: MD5 }), makeCtx())
    await expect(call).rejects.toThrow(/could not start the Python interpreter/)
    await expect(call).rejects.toThrow(/Install Python 3|RECONIX_PYTHON/)
    await expect(call).rejects.toMatchObject({ name: 'ToolExecError', code: 'TOOL_EXEC' })
  })

  it("explains a missing sidecar script (python can't open file)", async () => {
    mockExec((_args, cb) => {
      const err = new Error('Command failed: python3 ...') as ExecError
      err.code = 2
      cb(err, '', "python3: can't open file '/repo/.opencode/tools/identify_hash.py': [Errno 2] No such file or directory")
    })

    await expect(tool.execute(tool.parse({ hash: MD5 }), makeCtx())).rejects.toThrow(
      /sidecar script was not found/
    )
  })

  it('rejects non-JSON stdout with an actionable message', async () => {
    mockExec((_args, cb) => cb(null, 'Traceback (most recent call last): ...\n', ''))

    await expect(tool.execute(tool.parse({ hash: MD5 }), makeCtx())).rejects.toThrow(
      /not valid JSON/
    )
  })

  it('rejects empty stdout instead of reporting "no candidates"', async () => {
    mockExec((_args, cb) => cb(null, '   ', ''))

    await expect(tool.execute(tool.parse({ hash: MD5 }), makeCtx())).rejects.toThrow(
      /wrote nothing to stdout/
    )
  })

  it('surfaces stderr when the sidecar exits non-zero', async () => {
    mockExec((_args, cb) => {
      const err = new Error('Command failed') as ExecError
      err.code = 1
      cb(err, '', 'boom: unexpected failure')
    })

    const call = tool.execute(tool.parse({ hash: MD5 }), makeCtx())
    await expect(call).rejects.toThrow(/sidecar failed \(exit 1\)/)
    await expect(call).rejects.toThrow(/boom: unexpected failure/)
  })

  it('reports a timeout as retriable', async () => {
    mockExec((_args, cb) => {
      const err = new Error('Command failed: ETIMEDOUT') as ExecError
      err.killed = true
      cb(err, '', '')
    })

    await expect(tool.execute(tool.parse({ hash: MD5 }), makeCtx())).rejects.toMatchObject({
      name: 'ToolExecError',
      retriable: true
    })
  })
})

describe('parseSidecarOutput shape checks', () => {
  it('derives primaryType by confidence when the sidecar omits it', () => {
    const out = parseSidecarOutput(
      JSON.stringify({
        hash: MD5,
        candidates: [
          { type: 'NTLM', confidence: 0.8 },
          { type: 'MD5', confidence: 0.95 }
        ],
        advisory: ADVISORY
      }),
      MD5
    )
    expect(out.primaryType).toBe('MD5')
    expect(out.length).toBe(32)
    expect(out.crackStrategy).toBeUndefined()
  })

  it('rejects a payload without candidates or advisory', () => {
    expect(() => parseSidecarOutput(JSON.stringify({ hash: MD5 }), MD5)).toThrow(/candidates/)
    expect(() =>
      parseSidecarOutput(JSON.stringify({ hash: MD5, candidates: [] }), MD5)
    ).toThrow(/advisory/)
    expect(() => parseSidecarOutput(JSON.stringify([1, 2]), MD5)).toThrow(/instead of a JSON object/)
  })
})
