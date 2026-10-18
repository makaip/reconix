import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeHarnessDump } from './deobfuscateTrace'

// The harness is an in-page snippet, not a module, so we execute it in an
// isolated `node:vm` realm with its own intrinsics. This keeps its patches to
// String/Date/etc. from leaking into the rest of the test process, and lets us
// drive it exactly as the browser layer would.
const HARNESS = readFileSync(
  join(process.cwd(), '.opencode', 'tools', 'deobfuscate_harness.js'),
  'utf8'
)

type Sandbox = Record<string, unknown>

function makeSandbox(): Sandbox {
  const sandbox: Sandbox = {}
  const win = sandbox as any
  win.window = sandbox
  win.globalThis = sandbox
  win.console = console
  win.atob = (s: string) => Buffer.from(s, 'base64').toString('binary')
  win.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64')
  win.unescape = (s: string) => decodeURIComponent(s)
  win.escape = (s: string) => encodeURIComponent(s)
  win.decodeURIComponent = decodeURIComponent
  win.encodeURIComponent = encodeURIComponent
  win.decodeURI = decodeURI
  win.encodeURI = encodeURI
  win.setTimeout = () => 1
  win.setInterval = () => 1
  win.document = { readyState: 'loading', write() {}, writeln() {} }
  win.location = { href: 'https://target.test/page' }
  createContext(sandbox)
  return sandbox
}

function install(sandbox: Sandbox): any {
  return JSON.parse(runInContext(HARNESS, sandbox) as string)
}

function dump(sandbox: Sandbox): any {
  return JSON.parse(runInContext(HARNESS, sandbox) as string)
}

describe('deobfuscate_harness', () => {
  let sandbox: Sandbox

  beforeAll(() => {
    sandbox = makeSandbox()
  })

  it('installs and reports the detected phase', () => {
    const result = install(sandbox)
    expect(result.status).toBe('installed')
    expect(result.phase).toBe('pre-document')
  })

  it('records eval, codec, char-code and document.write sinks', () => {
    runInContext("atob('aGVsbG8=');", sandbox)
    runInContext('String.fromCharCode(104,105,106,107,108,109,110,111);', sandbox)
    runInContext("document.write('<script>x</script>');", sandbox)
    runInContext("eval('var a = 1;');", sandbox)

    const trace = dump(sandbox)
    expect(trace.status).toBe('dumped')
    expect(trace.schemaVersion).toBe(1)

    const kinds = trace.entries.map((e: any) => e.kind)
    expect(kinds).toContain('atob')
    expect(kinds).toContain('String.fromCharCode')
    expect(kinds).toContain('document.write')
    expect(kinds).toContain('eval')

    const atobEntry = trace.entries.find((e: any) => e.kind === 'atob')
    expect(atobEntry.result).toBe('hello')
    expect(atobEntry.phase).toBe('pre-document')
    expect(atobEntry.sourceUrl).toBe('https://target.test/page')

    const charEntry = trace.entries.find((e: any) => e.kind === 'String.fromCharCode')
    expect(charEntry.codes).toEqual([104, 105, 106, 107, 108, 109, 110, 111])

    const writeEntry = trace.entries.find((e: any) => e.kind === 'document.write')
    expect(writeEntry.code).toBe('<script>x</script>')
  })

  it('produces records the normalizer accepts', () => {
    const trace = normalizeHarnessDump(dump(sandbox))
    expect(trace.records.length).toBeGreaterThan(0)
    expect(trace.records.some((r) => r.stack !== undefined)).toBe(true)
  })

  it('counts dropped records once the entry cap is reached', () => {
    const fresh = makeSandbox()
    install(fresh)
    const calls = Array.from({ length: 405 }, () => "atob('aGk=');").join('\n')
    runInContext(calls, fresh)
    const trace = dump(fresh)
    expect(trace.entries).toHaveLength(400)
    expect(trace.dropped).toBe(5)
  })

  it('clears the trace on command', () => {
    const fresh = makeSandbox()
    install(fresh)
    runInContext("atob('aGk=');", fresh)
    fresh.__reconix_deobf_cmd__ = 'clear'
    expect(JSON.parse(runInContext(HARNESS, fresh) as string).status).toBe('cleared')
    expect(dump(fresh).entries).toHaveLength(0)
  })

  it('restores patched globals on uninstall', () => {
    const fresh = makeSandbox()
    const originalAtob = fresh.atob
    install(fresh)
    expect(fresh.atob).not.toBe(originalAtob)
    fresh.__reconix_deobf_cmd__ = 'uninstall'
    expect(JSON.parse(runInContext(HARNESS, fresh) as string).status).toBe('uninstalled')
    expect(fresh.atob).toBe(originalAtob)
    expect(fresh.__reconix_deobf_installed).toBeUndefined()
  })

  it('honors configurable caps from __reconix_deobf_config__', () => {
    const fresh = makeSandbox()
    ;(fresh as any).__reconix_deobf_config__ = { fromCharCodeMin: 2 }
    install(fresh)
    runInContext('String.fromCharCode(104,105);', fresh)
    const trace = dump(fresh)
    const entry = trace.entries.find((e: any) => e.kind === 'String.fromCharCode')
    expect(entry.codes).toEqual([104, 105])
  })
})
