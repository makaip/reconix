// API.md §3.2 — Navigation & page read (tier R). `navigate` is scope-checked
// via target(); the rest read the already-loaded page.
import { defineTool, type Tool, type ToolContext } from '../tool'
import { urlString } from '../validate'
import { ToolExecError } from '../errors'
import { capArray } from '../limits'
// Bundle secret scanning reuses the pure-compute detect_secrets pattern table
// (and its redaction) rather than keeping a second copy of the matchers here.
import { detectSecretsTool } from '../../../tools/detectSecrets'

// cdp.evaluate returns the page value already JSON-stringified; a tool that
// wants structure parses it back. Keeps the DOM-walking expressions readable.
async function evalJson<T>(ctx: ToolContext, expression: string): Promise<T> {
  const raw = await ctx.cdp.evaluate(expression)
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new ToolExecError(
      `page returned non-JSON result: ${raw.slice(0, 200)} — ` +
        'the page may still be loading; check get_page_info or navigate and retry'
    )
  }
}

// Walks document.forms into a plain, serializable shape. Password values are
// never read back. Shared by get_dom_extract and list_forms. `method` is read
// off the IDL property (not the attribute) so a form with no method attribute —
// or an invalid one — reports 'get', exactly as submit_form will send it.
const FORMS_EXPR = `[...document.forms].map((f,i)=>({
  index:i,
  selector:f.id ? '#'+CSS.escape(f.id) : (f.getAttribute('name') ? 'form[name='+JSON.stringify(f.getAttribute('name'))+']' : null),
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
    const truncated = forms.omitted > 0 || links.omitted > 0 || endpoints.omitted > 0
    return {
      ...raw,
      forms: forms.items,
      links: links.items,
      endpoints: endpoints.items,
      omitted: { forms: forms.omitted, links: links.omitted, endpoints: endpoints.omitted },
      returned: { forms: forms.items.length, links: links.items.length, endpoints: endpoints.items.length },
      truncated,
      note: truncated
        ? `extract capped to fit context — forms ${forms.items.length}/${raw.forms.length}, ` +
          `links ${links.items.length}/${raw.links.length}, endpoints ${endpoints.items.length}/${raw.endpoints.length}. ` +
          'Use query_dom or list_links for the omitted items.'
        : undefined
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
    return {
      forms: items,
      total: all.length,
      returned: items.length,
      omitted,
      truncated: omitted > 0,
      note:
        all.length === 0
          ? 'no forms found on this page — forms may be rendered later or live in an iframe; try get_dom_extract or query_dom("form") after the page settles'
          : omitted > 0
            ? `only the first ${items.length} of ${all.length} forms are included; refine with query_dom`
            : undefined
    }
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
      returned: items.length,
      omitted,
      truncated: omitted > 0,
      note:
        hrefs.length === 0
          ? 'no links found on this page — check the page finished loading, or crawl from here with crawl_start'
          : omitted > 0
            ? `only the first ${items.length} of ${hrefs.length} links are included; narrow the page or paginate with crawl_start`
            : undefined
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
    // Hash-fragment routes (`/#/login`) never reach the server, so captured
    // request URLs omit the fragment; compare without it or every SPA route
    // misses its own document response.
    const pageUrl = url.split('#')[0]
    const forUrl = entries.filter(
      (e) => (e.url === pageUrl || e.url === url || e.url.split('#')[0] === pageUrl) && e.responseHeaders
    )
    const match =
      [...forUrl].reverse().find((e) => /mainframe|document|main_frame/i.test(e.resourceType)) ??
      forUrl[forUrl.length - 1]
    if (!match) {
      throw new ToolExecError(
        `no captured response headers for the current document (${url}) — ` +
          `the page may predate capture, or be a non-http document; navigate to refresh, ` +
          `then retry or inspect raw entries with get_network_log`,
        true
      )
    }
    const headers = match.responseHeaders ?? {}
    return {
      url: match.url,
      statusCode: match.statusCode,
      headers,
      note:
        Object.keys(headers).length === 0
          ? 'the captured document response carried no headers — it may have been served from cache or truncated before capture'
          : undefined
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
    const omittedChars = (store: Record<string, string | null> | undefined): number =>
      Object.values(store ?? {}).reduce(
        (n, v) => (typeof v === 'string' && v.length > STORAGE_VALUE_MAX ? n + (v.length - STORAGE_VALUE_MAX) : n),
        0
      )
    const counts = {
      localStorage: {
        total: Object.keys(ls.values).length,
        returned: Object.keys(ls.values).length,
        truncatedValues: ls.truncated.length,
        omittedChars: omittedChars(data.localStorage)
      },
      sessionStorage: {
        total: Object.keys(ss.values).length,
        returned: Object.keys(ss.values).length,
        truncatedValues: ss.truncated.length,
        omittedChars: omittedChars(data.sessionStorage)
      }
    }
    const anyTruncated = ls.truncated.length + ss.truncated.length > 0
    return {
      localStorage: ls.values,
      sessionStorage: ss.values,
      // Keys whose value was cut, so the agent re-reads deliberately rather than
      // reasoning on a partial token as if it were complete.
      truncated: { localStorage: ls.truncated, sessionStorage: ss.truncated },
      // Explicit boolean + counts: `truncated` above names the keys, so a plain
      // truthiness check on it can never answer "was anything cut?".
      truncatedAny: anyTruncated,
      counts,
      maxValueChars: STORAGE_VALUE_MAX,
      note: anyTruncated
        ? `some values were cut at ${STORAGE_VALUE_MAX} chars (see truncated.localStorage / truncated.sessionStorage); ` +
          'keys listed there are partial — re-read them deliberately (e.g. via eval_in_page) before trusting them'
        : undefined
    }
  }
})

// Route-shaped string literals ('/api/x', "/login?next=1", `/v2/users`). The
// page expression below embeds the same pattern; keeping the TS copy here means
// inline and bundle bodies are scanned by identical rules.
const ROUTE_RE = /["'`](\/[a-zA-Z0-9_\-./?=&%]+)["'`]/g
const ROUTE_MIN = 2
const ROUTE_MAX = 199
const MAX_ROUTES = 200

// External-bundle budget. Bundles are megabytes of minified JS; pulling them all
// would blow both the request time and the context window, so we scan a bounded
// number of same-origin scripts within a bounded byte budget and report exactly
// what was cut.
const MAX_EXTERNAL_SCRIPTS = 20
const MAX_EXTERNAL_SCRIPT_BYTES = 2_000_000
const MAX_SECRET_HITS = 10

/** Add every route-shaped literal in `text` to `into`; returns how many were new. */
function collectRoutes(text: string, into: Set<string>): number {
  ROUTE_RE.lastIndex = 0
  let added = 0
  let m: RegExpExecArray | null
  while ((m = ROUTE_RE.exec(text)) !== null) {
    const route = m[1]
    if (route.length <= ROUTE_MIN || route.length > ROUTE_MAX) continue
    if (into.has(route)) continue
    into.add(route)
    added++
  }
  return added
}

const SECRET_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

const extract_js_routes = defineTool<Record<string, never>, unknown>({
  name: 'extract_js_routes',
  description:
    'Extract candidate API routes/endpoints from the current page’s scripts: INLINE <script> blocks ' +
    'plus SAME-ORIGIN external bundles (script[src]), which are re-fetched through the target session. ' +
    'External scanning is scope-checked and capped (' +
    `${MAX_EXTERNAL_SCRIPTS} scripts / ${MAX_EXTERNAL_SCRIPT_BYTES} bytes); cross-origin and ` +
    'out-of-scope srcs are never fetched. Bundle bodies are also scanned for secret-shaped strings ' +
    '(redacted). `externalScripts` is how many srcs the page has; `externalScriptsScanned` how many ' +
    'were actually read.',
  riskTier: 'R',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object' },
  parse: () => ({}),
  execute: async (_i, ctx) => {
    const data = await evalJson<{
      routes: string[]
      total: number
      externalScripts: number
      scriptSrcs: string[]
    }>(ctx, `(()=>{
      const scripts = Array.from(document.querySelectorAll('script'));
      const src = scripts.map(s=>s.textContent||'').join('\\n');
      const re = /["'\`](\\/[a-zA-Z0-9_\\-./?=&%]+)["'\`]/g;
      const set = new Set(); let m;
      while((m=re.exec(src))!==null){ if(m[1].length>2 && m[1].length<200) set.add(m[1]); }
      // Distinct, absolute srcs — the DOM keeps no body for these, so they have to
      // be re-fetched. Capped in-page so a pathological page can't produce a
      // huge CDP payload; the same-origin filter downstream is what matters.
      const srcs = [...new Set(scripts.filter(s=>s.src).map(s=>s.src))].slice(0,100);
      return {routes:[...set].slice(0,200), total:set.size, externalScripts:srcs.length, scriptSrcs:srcs};
    })()`)

    // Routes are de-duplicated across inline + external bodies; `total` stays the
    // true union size so omitted/truncated accounting is honest.
    const seen = new Set(data.routes)
    let total = data.total

    // Only the page's own origin is re-fetched: a CDN/third-party bundle would
    // be both out of the engagement's origin and a wasted request. Scope is
    // re-checked per URL as well (it is the authority, not the origin compare).
    const { url: pageUrl } = await ctx.cdp.pageInfo()
    let pageOrigin: string | null = null
    try {
      pageOrigin = new URL(pageUrl).origin
    } catch {
      pageOrigin = null
    }

    const skipped = { crossOrigin: 0, outOfScope: 0, overScriptLimit: 0, overByteBudget: 0, failed: 0 }
    let scriptsScanned = 0
    let bytesScanned = 0
    let budgetExhausted = false
    const secretHits: Array<{ type: string; redacted: string; confidence: string; script: string }> = []
    const secretKeys = new Set<string>()

    for (const src of data.scriptSrcs) {
      if (scriptsScanned >= MAX_EXTERNAL_SCRIPTS) {
        skipped.overScriptLimit++
        continue
      }
      let origin: string | null = null
      try {
        origin = new URL(src).origin
      } catch {
        origin = null
      }
      if (!origin || !pageOrigin || origin !== pageOrigin) {
        skipped.crossOrigin++
        continue
      }
      if (!ctx.scope.isInScope(src)) {
        skipped.outOfScope++
        continue
      }
      const remaining = MAX_EXTERNAL_SCRIPT_BYTES - bytesScanned
      if (remaining <= 0) {
        budgetExhausted = true
        skipped.overByteBudget++
        continue
      }

      let body: string
      try {
        const res = await ctx.cdp.sendRequest({ url: src, method: 'GET' })
        // A 3xx/4xx/5xx body is an error page, not a bundle — scanning it would
        // only invent routes from HTML.
        if (res.status < 200 || res.status >= 300) {
          skipped.failed++
          continue
        }
        body = res.body
      } catch {
        // One unreachable bundle must not fail the whole extract; it is counted.
        skipped.failed++
        continue
      }

      scriptsScanned++
      const slice = body.length > remaining ? body.slice(0, remaining) : body
      if (slice.length < body.length) budgetExhausted = true
      bytesScanned += slice.length

      total += collectRoutes(slice, seen)

      // Secret shapes reuse the detect_secrets capability so the pattern table
      // (and its redaction) lives in exactly one place. Hits are keyed by
      // type+redacted value: the same shipped key in 5 bundles is one finding.
      for (const hit of detectSecretsTool.handler({ body: slice }).hits) {
        const key = `${hit.type}|${hit.redacted}`
        if (secretKeys.has(key)) continue
        secretKeys.add(key)
        secretHits.push({ type: hit.type, redacted: hit.redacted, confidence: hit.confidence, script: src })
      }
    }

    // Highest-confidence first so a capped list still shows the real secrets.
    secretHits.sort((a, b) => (SECRET_RANK[a.confidence] ?? 3) - (SECRET_RANK[b.confidence] ?? 3))
    const secretTotal = secretHits.length
    const secrets = secretHits.slice(0, MAX_SECRET_HITS)

    const routes = [...seen].slice(0, MAX_ROUTES)
    const truncated = total > routes.length

    const parts: string[] = []
    if (truncated) parts.push(`routes capped at ${routes.length} of ${total}`)
    parts.push('inline script bodies were scanned')
    if (data.externalScripts === 0) {
      parts.push('no external scripts on this page')
    } else {
      parts.push(`${scriptsScanned}/${data.externalScripts} external script(s) scanned`)
      if (skipped.crossOrigin) parts.push(`${skipped.crossOrigin} cross-origin skipped`)
      if (skipped.outOfScope) parts.push(`${skipped.outOfScope} out-of-scope skipped`)
      if (skipped.overScriptLimit) parts.push(`${skipped.overScriptLimit} over the ${MAX_EXTERNAL_SCRIPTS}-script cap`)
      if (skipped.overByteBudget || budgetExhausted) {
        parts.push(`byte budget ${MAX_EXTERNAL_SCRIPT_BYTES} reached`)
      }
      if (skipped.failed) parts.push(`${skipped.failed} fetch(es) failed`)
    }
    if (secretTotal > secrets.length) parts.push(`${secretTotal - secrets.length} more secret hit(s) omitted`)
    parts.push('use get_network_log / get_request on a bundle for anything not fetched here')

    return {
      routes,
      total,
      returned: routes.length,
      omitted: Math.max(0, total - routes.length),
      truncated,
      externalScripts: data.externalScripts,
      externalScriptsScanned: scriptsScanned,
      externalScriptsSkipped: skipped,
      scriptBytesScanned: bytesScanned,
      secrets: {
        total: secretTotal,
        returned: secrets.length,
        omitted: Math.max(0, secretTotal - secrets.length),
        hits: secrets
      },
      note: parts.join('; ')
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
