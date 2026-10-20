// API.md §3.8 — Custom capability tools (component 5.E, Owner: Dev 1).
// Only `mutate_payload` lives here now; the rest of the capability set is
// bridged from src/tools via capabilities.ts to keep a single source of truth.
import { defineTool, type Tool } from '../tool'
import { str, enumOf } from '../validate'
import { ToolInputError } from '../errors'

const mutate_payload = defineTool<
  { seed: string; strategy: 'case' | 'insert' | 'truncate' | 'repeat' },
  { variants: string[] }
>({
  name: 'mutate_payload',
  description: 'Produce mutations of a seed string (data only).',
  riskTier: 'R',
  inputSchema: {
    type: 'object',
    required: ['seed', 'strategy'],
    properties: { seed: { type: 'string' }, strategy: { enum: ['case', 'insert', 'truncate', 'repeat'] } },
    additionalProperties: false
  },
  outputSchema: { type: 'object', properties: { variants: { type: 'array' } } },
  parse: (raw) => ({
    seed: str(raw, 'seed', 4096),
    strategy: enumOf(raw, 'strategy', ['case', 'insert', 'truncate', 'repeat'] as const)
  }),
  execute: async (i) => {
    const s = i.seed
    switch (i.strategy) {
      case 'case':
        return { variants: [s.toUpperCase(), s.toLowerCase(), [...s].map((c, n) => (n % 2 ? c.toUpperCase() : c.toLowerCase())).join('')] }
      case 'insert':
        return { variants: ['\u0000' + s, s + '\u0000', s.slice(0, 1) + '/*x*/' + s.slice(1)] }
      case 'truncate':
        return { variants: [s.slice(0, Math.ceil(s.length / 2)), s.slice(0, 1), ''] }
      case 'repeat':
        return { variants: [s + s, s.repeat(8), s.repeat(64)] }
      default:
        // Unreachable through parse(), but keeps the failure actionable if the
        // contract is ever bypassed.
        throw new ToolInputError(
          `unknown strategy "${String((i as { strategy?: unknown }).strategy)}" — use one of: case, insert, truncate, repeat`
        )
    }
  }
})

export const customTools: Tool[] = [mutate_payload as Tool]
