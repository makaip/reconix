// API.md §3.3 — Page interaction & CDP page-power (tier P, sandbox-only).
// Generous expressiveness (eval_in_page passes arbitrary expressions) is safe
// here: the target view is process-isolated, has no Node, and its network hits
// D's egress proxy. Each is still a named, logged, tiered tool.
import { defineTool, type Tool } from '../tool'
import { str } from '../validate'
import { ToolExecError } from '../errors'

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
  description: 'Set the value of an input matching selector.',
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
      `(()=>{const el=document.querySelector(${sel});if(!el)return false;el.value=${val};el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`
    )
    return { ok: r === 'true' }
  }
})

function pending(name: string, description: string): Tool {
  return defineTool<Record<string, never>, never>({
    name,
    description,
    riskTier: 'P',
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object' },
    parse: () => ({}),
    execute: async () => {
      throw new ToolExecError(`${name}: not implemented in Phase 1`)
    }
  }) as Tool
}

export const interactionTools: Tool[] = [
  eval_in_page as Tool,
  click as Tool,
  fill as Tool,
  pending('dispatch_input', 'Raw CDP Input event sequence into the target page.'),
  pending('query_dom', 'Query DOM nodes matching a selector.'),
  pending('set_dom', 'Set innerHTML of a node in the target page only.'),
  pending('set_emulation', 'CSS/Emulation: device, viewport, media.')
]
