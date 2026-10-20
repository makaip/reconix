// API.md §3.2 — Navigation & page read (tier R). `navigate` is scope-checked
// via target(); the rest read the already-loaded page.
import { defineTool, type Tool, type ToolContext } from '../tool'
import { urlString } from '../validate'
import { ToolExecError } from '../errors'
import { capArray } from '../limits'

// cdp.evaluate returns the page value already JSON-stringified; a tool that
// wants structure parses it back. Keeps the DOM-walking expressions readable.
async function evalJson<T>(ctx: ToolContext, expression: string): Promise<T> {
  const raw = await ctx.cdp.evaluate(expression)
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new ToolExecError(`page returned non-JSON result: ${raw.slice(0, 200)}`)
  }
}

// Walks document.forms into a plain, serializable shape. Password values are
// never read back. Shared by get_dom_extract and list_forms. `method` is read
// off the IDL property (not the attribute) so a form with no method attribute —
// or an invalid one — reports 'get', exactly as submit_form will send it.
const FORMS_EXPR = `[...document.forms].map((f,i)=>({
  index:i,
  name:f.getAttribute('name')||null,
  id:f.id||null,
  action:f.action||null,
  method:(f.method||'get').toLowerCase(),
  enctype:f.enctype||null,
  fields:[...f.elements].filter(e=>e.name||e.id).map(e=>({
    name:e.getAttribute('name')||null,
    id:e.id||null,
    type:(e.getAttribute('type')||e.tagName||'').toLowerCase(),
    required:!!e.required,
    value:e.type==='password'?null:(typeof e.value==='string'?e.value.slice(0,200):null)
  }))
}))`

const navigate = defineTool<{ url: string }, unknown>({
  name: 'navigate',
  description: 'Navigate the target view to a URL. Scope-checked.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: { url: { type: 'string', format: 'uri' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { status: {}, finalUrl: {} } },
  parse: (raw) => ({ url: urlString(raw, 'url') }),
  target: (i) => i.url, // <- pipeline scope-checks this before execute()
  execute: async (i, ctx) => {
    const { status, finalUrl } = await ctx.cdp.navigate(i.url)
    return { status, finalUrl }
  }
})

const get_page_info = defineTool<Record<string, never>, unknown>({
  name: 'get_page_info',
  description: 'Current url, title, readyState of the target view.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => ctx.cdp.pageInfo()
})

const get_cookies = defineTool<Record<string, never>, unknown>({
  name: 'get_cookies',
  description: 'Cookies for the target session (values redacted unless policy allows).',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'array' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const cookies = await ctx.cdp.cookies()
    if (ctx.policy.redactCookies) return cookies.map((c) => ({ ...c, value: '<redacted>' }))
    return cookies
  }
})

const screenshot = defineTool<{ fullPage?: boolean }, unknown>({
  name: 'screenshot',
  description: 'Capture the target view; returns a trace ref, not inline bytes.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    properties: { fullPage: { type: 'boolean' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { traceRef: { type: 'string' } } },
  parse: (raw) => {
    const r = raw as { fullPage?: unknown }
    return typeof r?.fullPage === 'boolean' ? { fullPage: r.fullPage } : {}
  },
  execute: async (i, ctx) => {
    const png = await ctx.cdp.screenshot(i.fullPage)
    return { traceRef: await ctx.traces.save('screenshot', png) }
  }
})

// Schema'd DOM extract: forms/inputs/endpoints/links/meta-headers/CSRF markers.
// One page read so the agent gets a coherent snapshot of the attack surface.
const get_dom_extract = defineTool<Record<string, never>, unknown>({
  name: 'get_dom_extract',
  description: 'Schema’d DOM extract: forms/inputs/endpoints/links/headers/CSRF.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const raw = await evalJson<{
      url: string
      title: string
      counts: Record<string, number>
      forms: unknown[]
      links: string[]
      endpoints: string[]
      metaHeaders: unknown[]
      csrf: unknown
    }>(
      ctx,
      `(()=>{
        const forms=${FORMS_EXPR};
        const links=[...new Set([...document.querySelectorAll('a[href]')].map(a=>a.href).filter(Boolean))];
        const endpoints=[...new Set([
          ...forms.map(f=>f.action).filter(Boolean),
          ...[...document.querySelectorAll('[src]')].map(e=>e.src).filter(Boolean)
        ])];
        const metaHeaders=[...document.querySelectorAll('meta[http-equiv]')]
          .map(m=>({name:m.getAttribute('http-equiv'),content:m.getAttribute('content')}));
        const csrfMeta=[...document.querySelectorAll('meta[name]')]
          .filter(m=>/csrf|xsrf/i.test(m.getAttribute('name')||''))
          .map(m=>({name:m.getAttribute('name'),content:m.getAttribute('content')}));
        const csrfInputs=[...document.querySelectorAll('input[name]')]
          .filter(i=>/csrf|xsrf|authenticity_token|_token/i.test(i.getAttribute('name')||''))
          .map(i=>({name:i.name,hasValue:!!i.value}));
        return {url:location.href,title:document.title,
          counts:{forms:forms.length,links:links.length,endpoints:endpoints.length},
          forms,links,endpoints,metaHeaders,csrf:{meta:csrfMeta,inputs:csrfInputs}};
      })()`
    )
    // The page's own counts stay accurate; the returned arrays are capped so a
    // large page can't overflow the context in one extract.
    const forms = capArray(raw.forms, 40)
    const links = capArray(raw.links, 80)
    const endpoints = capArray(raw.endpoints, 80)
    return {
      ...raw,
      forms: forms.items,
      links: links.items,
      endpoints: endpoints.items,
      omitted: { forms: forms.omitted, links: links.omitted, endpoints: endpoints.omitted }
    }
  }
})

const list_forms = defineTool<Record<string, never>, unknown>({
  name: 'list_forms',
  description: 'Forms on the current page with identity refs.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { forms: { type: 'array' } } },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const all = await evalJson<unknown[]>(ctx, `(()=>(${FORMS_EXPR}))()`)
    const { items, omitted } = capArray(all, 40)
    return { forms: items, total: all.length, omitted }
  }
})

// Links on the page, each tagged in/out of scope via the same enforcer the
// pipeline uses — so recon and gating never disagree.
const list_links = defineTool<Record<string, never>, unknown>({
  name: 'list_links',
  description: 'Links on the current page, in/out of scope.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { links: { type: 'array' } } },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const hrefs = await evalJson<string[]>(
      ctx,
      `(()=>[...new Set([...document.querySelectorAll('a[href]')].map(a=>a.href).filter(Boolean))])()`
    )
    const { items, omitted } = capArray(hrefs, 80)
    return {
      links: items.map((url) => ({ url, inScope: ctx.scope.isInScope(url) })),
      total: hrefs.length,
      omitted
    }
  }
})

// Response headers of the current document. We don't re-fetch — we read the
// headers already captured for the main-document request on this target.
const get_headers = defineTool<Record<string, never>, unknown>({
  name: 'get_headers',
  description: 'Response headers of the current document.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const { url } = await ctx.cdp.pageInfo()
    const entries = ctx.network.list()
    // Prefer the most recent main-document response for the current URL; fall
    // back to the newest entry carrying response headers for that URL.
    // Electron's webRequest tags the top document 'mainFrame'; CDP/other
    // sources may say 'document' — accept either.
    const forUrl = entries.filter((e) => e.url === url && e.responseHeaders)
    const match =
      [...forUrl].reverse().find((e) => /mainframe|document|main_frame/i.test(e.resourceType)) ??
      forUrl[forUrl.length - 1]
    if (!match) {
      throw new ToolExecError(
        `no captured response headers for the current document (${url}) — ` +
          `the page may predate capture, or be a non-http document; navigate to refresh`,
        true
      )
    }
    return {
      url: match.url,
      statusCode: match.statusCode,
      headers: match.responseHeaders
    }
  }
})

// Per-value ceiling for storage dumps. A single localStorage entry holding a
// big JWT/state blob is common; without a per-value clamp the whole result blows
// the context budget and the server-level clamp cuts the JSON mid-object.
const STORAGE_VALUE_MAX = 2000

const get_storage = defineTool<Record<string, never>, unknown>({
  name: 'get_storage',
  description: 'Dump localStorage, sessionStorage, and (best-effort) IndexedDB keys from the current page.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const data = await evalJson<{
      localStorage?: Record<string, string | null>
      sessionStorage?: Record<string, string | null>
    }>(ctx, `(()=>{
      const ls={}; for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); ls[k]=localStorage.getItem(k);}
      const ss={}; for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i); ss[k]=sessionStorage.getItem(k);}
      return {localStorage:ls, sessionStorage:ss};
    })()`)
    const clamp = (
      store: Record<string, string | null> | undefined
    ): { values: Record<string, string | null>; truncated: string[] } => {
      const values: Record<string, string | null> = {}
      const truncated: string[] = []
      for (const [k, v] of Object.entries(store ?? {})) {
        if (typeof v === 'string' && v.length > STORAGE_VALUE_MAX) {
          values[k] = `${v.slice(0, STORAGE_VALUE_MAX)}…[+${v.length - STORAGE_VALUE_MAX} chars]`
          truncated.push(k)
        } else {
          values[k] = v
        }
      }
      return { values, truncated }
    }
    const ls = clamp(data.localStorage)
    const ss = clamp(data.sessionStorage)
    return {
      localStorage: ls.values,
      sessionStorage: ss.values,
      // Keys whose value was cut, so the agent re-reads deliberately rather than
      // reasoning on a partial token as if it were complete.
      truncated: { localStorage: ls.truncated, sessionStorage: ss.truncated },
      maxValueChars: STORAGE_VALUE_MAX
    }
  }
})

const extract_js_routes = defineTool<Record<string, never>, unknown>({
  name: 'extract_js_routes',
  description:
    'Extract candidate API routes/endpoints from INLINE <script> blocks on the current page. ' +
    'External scripts (script[src]) are not fetched — their bodies are not available to the page ' +
    'DOM — so bundles served from src are skipped; `externalScripts` reports how many were skipped. ' +
    'For those, use get_network_log / get_request on the bundle responses.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const data = await evalJson<{ routes: string[]; externalScripts: number }>(ctx, `(()=>{
      const src = Array.from(document.querySelectorAll('script')).map(s=>s.textContent||'').join('\\n');
      const re = /["'\`](\\/[a-zA-Z0-9_\\-./?=&%]+)["'\`]/g;
      const set = new Set(); let m;
      while((m=re.exec(src))!==null){ if(m[1].length>2 && m[1].length<200) set.add(m[1]); }
      return {routes:[...set].slice(0,200), externalScripts:document.querySelectorAll('script[src]').length};
    })()`)
    // TODO: optionally fetch same-origin script src and scan their bodies too
    // (would need a scope-checked read through ctx.cdp + its own budget cap).
    return {
      routes: data.routes,
      externalScripts: data.externalScripts,
      externalScriptsScanned: false,
      note:
        data.externalScripts > 0
          ? `${data.externalScripts} external script(s) skipped — only inline script bodies were scanned.`
          : 'No external scripts on this page; only inline script bodies were scanned.'
    }
  }
})

export const navigationTools: Tool[] = [
  navigate as Tool,
  get_page_info as Tool,
  get_cookies as Tool,
  screenshot as Tool,
  get_dom_extract as Tool,
  list_forms as Tool,
  list_links as Tool,
  get_headers as Tool,
  get_storage as Tool,
  extract_js_routes as Tool
]
