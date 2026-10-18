// API.md §3.3 — Page interaction & CDP page-power (tier P, sandbox-only).
// Generous expressiveness (eval_in_page passes arbitrary expressions) is safe
// here: the target view is process-isolated, has no Node, and its network hits
// D's egress proxy. Each is still a named, logged, tiered tool.
import { defineTool, type Tool, type ToolContext } from '../tool'
import { str, optStr } from '../validate'
import { ToolExecError, ToolInputError } from '../errors'
import { uploadFiles } from './upload'

// cdp.evaluate hands back the page value already JSON-stringified; parse it
// when the tool wants structure instead of text.
async function evalJson<T>(ctx: ToolContext, expression: string): Promise<T> {
  const raw = await ctx.cdp.evaluate(expression)
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new ToolExecError(`page returned non-JSON result: ${raw.slice(0, 200)}`)
  }
}

const eval_in_page = defineTool<{ expression: string }, unknown>({
  name: 'eval_in_page',
  description: 'Runtime.evaluate in the target page. Result rendered as text in the UI.',
  riskTier: 'P',
  inputSchema: {
    type: 'object',
    required: ['expression'],
    properties: { expression: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { resultText: { type: 'string' } } },
  parse: (raw) => ({ expression: str(raw, 'expression') }),
  execute: async (i, ctx) => ({ resultText: await ctx.cdp.evaluate(i.expression) })
})

const click = defineTool<{ selector: string }, unknown>({
  name: 'click',
  description: 'Click the first element matching selector in the target page.',
  riskTier: 'P',
  inputSchema: {
    type: 'object',
    required: ['selector'],
    properties: { selector: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  parse: (raw) => ({ selector: str(raw, 'selector') }),
  execute: async (i, ctx) => {
    const sel = JSON.stringify(i.selector)
    const r = await ctx.cdp.evaluate(
      `(()=>{const el=document.querySelector(${sel});if(!el)return false;el.click();return true;})()`
    )
    return { ok: r === 'true' }
  }
})

const fill = defineTool<{ selector: string; value: string }, unknown>({
  name: 'fill',
  description: 'Set the value of a text input matching selector. Cannot upload files or set a file input to a filename; an empty value can clear a file input.',
  riskTier: 'P',
  inputSchema: {
    type: 'object',
    required: ['selector', 'value'],
    properties: { selector: { type: 'string' }, value: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  parse: (raw) => ({ selector: str(raw, 'selector'), value: str(raw, 'value') }),
  execute: async (i, ctx) => {
    const sel = JSON.stringify(i.selector)
    const val = JSON.stringify(i.value)
    const r = await ctx.cdp.evaluate(
      `(()=>{const el=document.querySelector(${sel});if(!el)return false;if(el.tagName==='INPUT'&&el.type==='file'&&${val}!=='')return 'file-input';el.value=${val};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`
    )
    if (r === JSON.stringify('file-input')) {
      throw new ToolInputError('fill cannot upload files or assign filenames to file inputs. Use reconix_upload_files with the selector and actual file contents, or an approved multipart request through replay_request. Do not repeat fill or click the file picker for this approach.')
    }
    return { ok: r === 'true' }
  }
})

// Raw CDP Input event sequence into the target page. The events are opaque CDP
// payloads; we validate the envelope (a non-empty array of objects) and let the
// driver forward them — invalid events surface as a CDP exec error, not a crash.
const dispatch_input = defineTool<{ events: object[] }, unknown>({
  name: 'dispatch_input',
  description: 'Raw CDP Input event sequence into the target page.',
  riskTier: 'P',
  inputSchema: {
    type: 'object',
    required: ['events'],
    properties: { events: { type: 'array', items: { type: 'object' } } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  parse: (raw) => {
    const v = (raw as { events?: unknown })?.events
    if (!Array.isArray(v) || v.length === 0) {
      throw new ToolInputError('"events" must be a non-empty array')
    }
    if (v.some((e) => typeof e !== 'object' || e === null || Array.isArray(e))) {
      throw new ToolInputError('each event in "events" must be an object')
    }
    return { events: v as object[] }
  },
  execute: async (i, ctx) => {
    await ctx.cdp.dispatchInput(i.events)
    return { ok: true }
  }
})

const query_dom = defineTool<{ selector: string }, unknown>({
  name: 'query_dom',
  description: 'Query DOM nodes matching a selector.',
  riskTier: 'P',
  inputSchema: {
    type: 'object',
    required: ['selector'],
    properties: { selector: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { nodes: { type: 'array' } } },
  parse: (raw) => ({ selector: str(raw, 'selector') }),
  execute: (i, ctx) => {
    const sel = JSON.stringify(i.selector)
    // querySelectorAll can throw SyntaxError on a bad selector — catch it in
    // the page and hand back a tagged result so the tool reports a clean input
    // error rather than a raw page exception.
    return evalJson<{ nodes: unknown[] } | { error: string }>(
      ctx,
      // Caps (count + per-field length) keep a broad selector from overflowing
      // the context window; `total` tells the agent how many actually matched.
      `(()=>{let els;try{els=[...document.querySelectorAll(${sel})]}catch(e){return {error:'invalid selector: '+e.message}}
        const total=els.length;
        return {total,truncated:total>50,nodes:els.slice(0,50).map(el=>({
          tag:el.tagName.toLowerCase(),
          id:el.id||null,
          classes:el.className&&typeof el.className==='string'?el.className.split(/\\s+/).filter(Boolean):[],
          name:el.getAttribute&&el.getAttribute('name')||null,
          type:el.getAttribute&&el.getAttribute('type')||null,
          text:(el.textContent||'').trim().slice(0,120),
          html:(el.outerHTML||'').slice(0,200)
        }))}})()`
    ).then((r) => {
      if ('error' in r) throw new ToolInputError(r.error)
      return r
    })
  }
})

const set_dom = defineTool<{ selector: string; html: string }, unknown>({
  name: 'set_dom',
  description: 'Set innerHTML of a node in the target page only.',
  riskTier: 'P',
  inputSchema: {
    type: 'object',
    required: ['selector', 'html'],
    properties: { selector: { type: 'string' }, html: { type: 'string' } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  parse: (raw) => ({ selector: str(raw, 'selector'), html: str(raw, 'html') }),
  execute: async (i, ctx) => {
    const sel = JSON.stringify(i.selector)
    const html = JSON.stringify(i.html)
    const r = await ctx.cdp.evaluate(
      `(()=>{const el=document.querySelector(${sel});if(!el)return false;el.innerHTML=${html};return true;})()`
    )
    if (r !== 'true') throw new ToolExecError(`no element matched selector: ${i.selector}`)
    return { ok: true }
  }
})

interface EmulationInput {
  viewport?: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number }
  media?: string
  reset?: boolean
}

// CSS/Emulation: viewport, media, or reset. `device` from the API is accepted
// as a viewport preset shorthand but kept minimal — explicit viewport wins.
const set_emulation = defineTool<EmulationInput, unknown>({
  name: 'set_emulation',
  description: 'CSS/Emulation: device, viewport, media.',
  riskTier: 'P',
  inputSchema: {
    type: 'object',
    properties: {
      viewport: {
        type: 'object',
        required: ['width', 'height'],
        properties: {
          width: { type: 'number' },
          height: { type: 'number' },
          mobile: { type: 'boolean' },
          deviceScaleFactor: { type: 'number' }
        }
      },
      media: { type: 'string' },
      reset: { type: 'boolean' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  parse: (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>
    const out: EmulationInput = {}
    if (r.reset !== undefined) {
      if (typeof r.reset !== 'boolean') throw new ToolInputError('"reset" must be a boolean')
      out.reset = r.reset
    }
    if (r.media !== undefined) out.media = optStr(r, 'media')
    if (r.viewport !== undefined) {
      const v = r.viewport as Record<string, unknown>
      if (typeof v !== 'object' || v === null) throw new ToolInputError('"viewport" must be an object')
      const width = v.width
      const height = v.height
      if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
        throw new ToolInputError('"viewport.width" and "viewport.height" must be positive numbers')
      }
      out.viewport = {
        width,
        height,
        mobile: typeof v.mobile === 'boolean' ? v.mobile : undefined,
        deviceScaleFactor:
          typeof v.deviceScaleFactor === 'number' ? v.deviceScaleFactor : undefined
      }
    }
    if (!out.reset && !out.media && !out.viewport) {
      throw new ToolInputError('set_emulation needs at least one of: viewport, media, reset')
    }
    return out
  },
  execute: async (i, ctx) => {
    await ctx.cdp.setEmulation(i)
    return { ok: true }
  }
})

import { requestQuestion } from '../../questionBridge'

const ask_user = defineTool<
  { header: string; question: string; options?: string[]; multiple?: boolean },
  unknown
>({
  name: 'ask_user',
  description: 'Pause and ask the user a question with optional choices. Returns their answer.',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['question'],
    properties: {
      header: { type: 'string' },
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      multiple: { type: 'boolean' }
    },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { answer: {} } },
  parse: (raw) => {
    const r = (raw ?? {}) as Record<string, unknown>
    const question = typeof r.question === 'string' ? r.question : ''
    if (!question) throw new ToolInputError('"question" must be a non-empty string')
    const header = typeof r.header === 'string' ? r.header : 'Question'
    const options = Array.isArray(r.options) ? r.options.filter((x) => typeof x === 'string') as string[] : undefined
    const multiple = typeof r.multiple === 'boolean' ? r.multiple : false
    return { header, question, options, multiple }
  },
  execute: async (i) => {
    const answer = await requestQuestion({
      header: i.header,
      question: i.question,
      options: i.options,
      multiple: i.multiple
    })
    if (answer === null) return { cancelled: true }
    return { answer }
  }
})

export const interactionTools: Tool[] = [
  eval_in_page as Tool,
  click as Tool,
  fill as Tool,
  uploadFiles as Tool,
  dispatch_input as Tool,
  query_dom as Tool,
  set_dom as Tool,
  set_emulation as Tool,
  ask_user as Tool
]
