import { describe, expect, it } from 'vitest'
import { navigationTools } from './navigation'
import { interactionTools } from './interaction'
import { invokeTool } from '../pipeline'
import type { AuditLogger } from '../audit'
import type { ToolContext } from '../tool'
import type { Tool } from '../tool'
import type { CapturedRequest } from '../../../shared/tabs'
import type { EmulationOptions, HttpRequestSpec } from '../cdp'

// A minimal audit logger that just hands back ids — the pipeline requires one
// but these tests assert on tool output, not the audit trail.
const audit: AuditLogger = {
  recordIntent: async () => 'call-1',
  recordOutcome: async () => {}
} as unknown as AuditLogger

interface FakeCtx {
  ctx: ToolContext
  calls: { emulation: EmulationOptions[]; input: unknown[][]; fetched: string[] }
}

function makeCtx(opts: {
  pageUrl?: string
  evaluate?: (expr: string) => string | Promise<string>
  network?: CapturedRequest[]
  allowedHosts?: string[]
  /** Body server for script[src] fetches. Absent = the request throws (offline). */
  scripts?: (url: string) => { status?: number; body: string }
}): FakeCtx {
  const calls = { emulation: [] as EmulationOptions[], input: [] as unknown[][], fetched: [] as string[] }
  const pageUrl = opts.pageUrl ?? 'https://app.example.com/dash'
  const cdp = {
    navigate: async () => ({ status: 200, finalUrl: pageUrl }),
    pageInfo: async () => ({ url: pageUrl, title: 'T', readyState: 'complete' }),
    evaluate: async (expr: string) => (opts.evaluate ? opts.evaluate(expr) : 'null'),
    screenshot: async () => Buffer.from(''),
    cookies: async () => [],
    dispatchInput: async (events: unknown[]) => {
      calls.input.push(events)
    },
    setEmulation: async (o: EmulationOptions) => {
      calls.emulation.push(o)
    },
    sendRequest: async (spec: HttpRequestSpec) => {
      calls.fetched.push(spec.url)
      const served = opts.scripts?.(spec.url)
      if (!served) throw new Error(`ENOTFOUND ${spec.url}`)
      return {
        status: served.status ?? 200,
        statusText: 'OK',
        headers: {},
        body: served.body,
        bodyBytes: Buffer.byteLength(served.body),
        durationMs: 1
      }
    }
  }
  const allowed = opts.allowedHosts ?? ['app.example.com']
  const ctx = {
    engagementId: 'eng-1',
    cdp,
    scope: {
      config: {},
      isInScope: (t?: string) => {
        if (!t) return true
        try {
          return allowed.includes(new URL(t).hostname)
        } catch {
          return false
        }
      },
      assertInScope: () => {}
    },
    policy: { redactCookies: false },
    network: {
      list: () => opts.network ?? [],
      get: () => undefined
    }
  } as unknown as ToolContext
  return { ctx, calls }
}

function tool(name: string): Tool {
  const t = [...navigationTools, ...interactionTools].find((x) => x.name === name)
  if (!t) throw new Error(`missing tool ${name}`)
  return t
}

describe('navigation: get_headers', () => {
  it('returns the captured document response headers for the current url', async () => {
    const net: CapturedRequest[] = [
      // A same-URL non-document response must not win over the main frame.
      {
        id: 'r0',
        tabId: 1,
        method: 'GET',
        url: 'https://app.example.com/dash',
        resourceType: 'xhr',
        startedAt: 0,
        statusCode: 200,
        responseHeaders: { 'content-type': ['application/json'] }
      },
      {
        id: 'r1',
        tabId: 1,
        method: 'GET',
        url: 'https://app.example.com/dash',
        resourceType: 'mainFrame', // Electron webRequest value for the top document
        startedAt: 1,
        statusCode: 200,
        responseHeaders: { 'content-type': ['text/html'], 'x-frame-options': ['DENY'] }
      }
    ]
    const { ctx } = makeCtx({ network: net })
    const res = await invokeTool(tool('get_headers'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    expect(res.output).toMatchObject({
      url: 'https://app.example.com/dash',
      statusCode: 200,
      headers: { 'x-frame-options': ['DENY'] }
    })
  })

  it('fails with a clear message when nothing was captured', async () => {
    const { ctx } = makeCtx({ network: [] })
    const res = await invokeTool(tool('get_headers'), {}, ctx, audit)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_EXEC')
    expect(res.error?.message).toContain('no captured response headers')
  })
})

describe('navigation: list_links scope tagging', () => {
  it('tags each link in/out of scope using the enforcer', async () => {
    const { ctx } = makeCtx({
      evaluate: () => JSON.stringify(['https://app.example.com/a', 'https://evil.test/b']),
      allowedHosts: ['app.example.com']
    })
    const res = await invokeTool(tool('list_links'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    expect(res.output).toMatchObject({
      links: [
        { url: 'https://app.example.com/a', inScope: true },
        { url: 'https://evil.test/b', inScope: false }
      ],
      total: 2,
      omitted: 0
    })
  })

  it('caps a huge link list and reports how many were omitted', async () => {
    const many = Array.from({ length: 200 }, (_, n) => `https://app.example.com/p${n}`)
    const { ctx } = makeCtx({ evaluate: () => JSON.stringify(many) })
    const res = await invokeTool(tool('list_links'), {}, ctx, audit)
    const out = res.output as { links: unknown[]; total: number; omitted: number }
    expect(out.links.length).toBe(80)
    expect(out.total).toBe(200)
    expect(out.omitted).toBe(120)
  })
})

describe('navigation: get_dom_extract / list_forms parse page JSON', () => {
  it('returns parsed structure from the page', async () => {
    const payload = { url: 'https://app.example.com/dash', forms: [], links: [], endpoints: [] }
    const { ctx } = makeCtx({ evaluate: () => JSON.stringify(payload) })
    const res = await invokeTool(tool('get_dom_extract'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    expect(res.output).toMatchObject({ url: 'https://app.example.com/dash' })
  })

  it('surfaces a clear exec error when the page returns non-JSON', async () => {
    const { ctx } = makeCtx({ evaluate: () => 'undefined' })
    const res = await invokeTool(tool('list_forms'), {}, ctx, audit)
    expect(res.ok).toBe(false)
    expect(res.error?.message).toContain('non-JSON')
  })
})

describe('interaction: query_dom', () => {
  it('returns matched nodes', async () => {
    const { ctx } = makeCtx({
      evaluate: () => JSON.stringify({ nodes: [{ tag: 'a', id: 'x' }] })
    })
    const res = await invokeTool(tool('query_dom'), { selector: 'a' }, ctx, audit)
    expect(res.ok).toBe(true)
    expect(res.output).toMatchObject({ nodes: [{ tag: 'a', id: 'x' }] })
  })

  it('reports an invalid selector as an input error, not a crash', async () => {
    const { ctx } = makeCtx({ evaluate: () => JSON.stringify({ error: 'invalid selector: oops' }) })
    const res = await invokeTool(tool('query_dom'), { selector: ')(' }, ctx, audit)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })

  it('rejects a missing selector at parse time', async () => {
    const { ctx } = makeCtx({})
    const res = await invokeTool(tool('query_dom'), {}, ctx, audit)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })
})

describe('interaction: dispatch_input validation', () => {
  it('forwards a non-empty array of event objects', async () => {
    const { ctx, calls } = makeCtx({})
    const res = await invokeTool(
      tool('dispatch_input'),
      { events: [{ type: 'keyDown', key: 'a' }] },
      ctx,
      audit
    )
    expect(res.ok).toBe(true)
    expect(calls.input).toHaveLength(1)
  })

  it('rejects an empty event list', async () => {
    const { ctx } = makeCtx({})
    const res = await invokeTool(tool('dispatch_input'), { events: [] }, ctx, audit)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })
})

describe('interaction: set_emulation', () => {
  it('passes a validated viewport through to the driver', async () => {
    const { ctx, calls } = makeCtx({})
    const res = await invokeTool(
      tool('set_emulation'),
      { viewport: { width: 375, height: 812, mobile: true } },
      ctx,
      audit
    )
    expect(res.ok).toBe(true)
    expect(calls.emulation[0]).toMatchObject({ viewport: { width: 375, height: 812, mobile: true } })
  })

  it('rejects a call with no fields set', async () => {
    const { ctx } = makeCtx({})
    const res = await invokeTool(tool('set_emulation'), {}, ctx, audit)
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })

  it('rejects a non-positive viewport', async () => {
    const { ctx } = makeCtx({})
    const res = await invokeTool(
      tool('set_emulation'),
      { viewport: { width: 0, height: 100 } },
      ctx,
      audit
    )
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TOOL_INPUT')
  })
})

describe('no tool in the navigation/interaction catalog is a throwing stub', () => {
  it('every tool has a real executor', () => {
    const names = [...navigationTools, ...interactionTools].map((t) => t.name)
    expect(names).toContain('get_headers')
    expect(names).toContain('query_dom')
    expect(names).toContain('set_emulation')
  })
})

describe('navigation: get_storage clamps huge values', () => {
  it('clamps each value and names the truncated keys', async () => {
    const big = 'a'.repeat(5000)
    const { ctx } = makeCtx({
      evaluate: () =>
        JSON.stringify({
          localStorage: { token: big, small: 'ok' },
          sessionStorage: { state: big }
        })
    })
    const res = await invokeTool(tool('get_storage'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    const out = res.output as {
      localStorage: Record<string, string>
      sessionStorage: Record<string, string>
      truncated: { localStorage: string[]; sessionStorage: string[] }
      maxValueChars: number
    }
    expect(out.localStorage.small).toBe('ok')
    expect(out.localStorage.token.length).toBeLessThan(5000)
    expect(out.localStorage.token).toContain('chars]')
    expect(out.truncated.localStorage).toEqual(['token'])
    expect(out.truncated.sessionStorage).toEqual(['state'])
    expect(out.maxValueChars).toBe(2000)
    // the whole result still serializes as valid, bounded JSON
    expect(JSON.stringify(out).length).toBeLessThan(8000)
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })
})

// What the page expression returns for extract_js_routes.
function pageScripts(routes: string[], srcs: string[] = []): string {
  return JSON.stringify({ routes, total: routes.length, externalScripts: srcs.length, scriptSrcs: srcs })
}

interface RoutesOut {
  routes: string[]
  total: number
  returned: number
  omitted: number
  truncated: boolean
  externalScripts: number
  externalScriptsScanned: number
  externalScriptsSkipped: Record<string, number>
  scriptBytesScanned: number
  secrets: {
    total: number
    returned: number
    omitted: number
    hits: Array<{ type: string; redacted: string; confidence: string; script: string }>
  }
  note: string
}

describe('navigation: extract_js_routes (inline + external bundles)', () => {
  it('keeps the inline-only result working when the page has no script src', async () => {
    const { ctx, calls } = makeCtx({ evaluate: () => pageScripts(['/api/inline', '/login']) })
    const res = await invokeTool(tool('extract_js_routes'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    const out = res.output as RoutesOut
    expect(out.routes).toEqual(['/api/inline', '/login'])
    expect(out.externalScripts).toBe(0)
    expect(out.externalScriptsScanned).toBe(0)
    expect(calls.fetched).toEqual([])
    expect(out.note).toContain('no external scripts')
  })

  it('fetches same-origin bundles and merges their routes into the result', async () => {
    const bodies: Record<string, string> = {
      'https://app.example.com/a.js': 'fetch("/api/users")',
      'https://app.example.com/b.js': 'const u = `/api/orders/1`;'
    }
    const srcs = Object.keys(bodies)
    const { ctx, calls } = makeCtx({
      evaluate: () => pageScripts(['/api/inline'], srcs),
      scripts: (url) => ({ body: bodies[url] })
    })
    const res = await invokeTool(tool('extract_js_routes'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    const out = res.output as RoutesOut
    expect(calls.fetched).toEqual(srcs)
    expect(out.externalScripts).toBe(2)
    expect(out.externalScriptsScanned).toBe(2)
    expect(out.routes).toEqual(['/api/inline', '/api/users', '/api/orders/1'])
    expect(out.total).toBe(3)
    expect(out.omitted).toBe(0)
    expect(out.truncated).toBe(false)
  })

  it('never fetches cross-origin or out-of-scope scripts', async () => {
    const { ctx, calls } = makeCtx({
      evaluate: () =>
        pageScripts(
          ['/api/inline'],
          ['https://cdn.evil.test/x.js', 'https://other.example.com/y.js']
        ),
      scripts: () => ({ body: '"/api/leaked"' })
    })
    const res = await invokeTool(tool('extract_js_routes'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    const out = res.output as RoutesOut
    expect(calls.fetched).toEqual([])
    expect(out.routes).toEqual(['/api/inline'])
    expect(out.externalScriptsScanned).toBe(0)
    expect(out.externalScriptsSkipped.crossOrigin).toBe(2)

    // Same origin but outside allowed_hosts: the scope enforcer still wins.
    const outOfScope = makeCtx({
      allowedHosts: ['not-this-host.test'],
      evaluate: () => pageScripts([], ['https://app.example.com/x.js']),
      scripts: () => ({ body: '"/api/leaked"' })
    })
    const res2 = await invokeTool(tool('extract_js_routes'), {}, outOfScope.ctx, audit)
    const out2 = res2.output as RoutesOut
    expect(outOfScope.calls.fetched).toEqual([])
    expect(out2.externalScriptsScanned).toBe(0)
    expect(out2.externalScriptsSkipped.outOfScope).toBe(1)
    expect(out2.routes).toEqual([])
  })

  it('caps how many scripts it scans and reports the overflow', async () => {
    const srcs = Array.from({ length: 25 }, (_, n) => `https://app.example.com/s${n}.js`)
    const { ctx, calls } = makeCtx({
      evaluate: () => pageScripts([], srcs),
      scripts: () => ({ body: 'var a = 1;' })
    })
    const res = await invokeTool(tool('extract_js_routes'), {}, ctx, audit)
    const out = res.output as RoutesOut
    expect(out.externalScriptsScanned).toBe(20)
    expect(out.externalScriptsSkipped.overScriptLimit).toBe(5)
    expect(calls.fetched).toHaveLength(20)
  })

  it('stops at the byte budget instead of reading a whole bundle set', async () => {
    const filler = 'var a=1;'.repeat(112_500) // 900 kB
    const srcs = [1, 2, 3].map((n) => `https://app.example.com/big${n}.js`)
    const { ctx } = makeCtx({
      evaluate: () => pageScripts([], srcs),
      scripts: (url) => ({ body: `${filler}"/bulk/${url.slice(-4, -3)}"` })
    })
    const res = await invokeTool(tool('extract_js_routes'), {}, ctx, audit)
    const out = res.output as RoutesOut
    expect(out.scriptBytesScanned).toBe(2_000_000)
    expect(out.externalScriptsScanned).toBe(3)
    expect(out.routes).toContain('/bulk/1')
    expect(out.routes).toContain('/bulk/2')
    // The third bundle's tail (and its route) fell past the budget.
    expect(out.routes).not.toContain('/bulk/3')
    expect(out.note).toContain('byte budget')
  })

  it('counts failed and non-2xx fetches without failing the tool', async () => {
    const { ctx } = makeCtx({
      evaluate: () =>
        pageScripts([], ['https://app.example.com/gone.js', 'https://app.example.com/offline.js']),
      scripts: (url) => (url.endsWith('gone.js') ? { status: 404, body: '<html>nope</html>' } : undefined)
    })
    const res = await invokeTool(tool('extract_js_routes'), {}, ctx, audit)
    expect(res.ok).toBe(true)
    const out = res.output as RoutesOut
    expect(out.externalScriptsScanned).toBe(0)
    expect(out.externalScriptsSkipped.failed).toBe(2)
    expect(out.routes).toEqual([])
  })

  it('scans bundle bodies for secrets and only returns redacted hits', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE'
    const { ctx } = makeCtx({
      evaluate: () => pageScripts([], ['https://app.example.com/env.js']),
      scripts: () => ({ body: `const cfg = { apiKey: "${key}" };` })
    })
    const res = await invokeTool(tool('extract_js_routes'), {}, ctx, audit)
    const out = res.output as RoutesOut
    expect(out.secrets.total).toBeGreaterThan(0)
    expect(out.secrets.hits[0].type).toBe('aws-access-key-id')
    expect(out.secrets.hits[0].script).toBe('https://app.example.com/env.js')
    expect(JSON.stringify(out.secrets)).not.toContain(key)
  })
})
