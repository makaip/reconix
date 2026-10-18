import { describe, expect, it, vi } from 'vitest'

import type { CapabilityTool, ValidationResult } from '../../shared/tools'
import { fromCapabilityTool } from './descriptor'

type In = { n: number }
type Out = { doubled: number }

function makeTool(overrides: Partial<CapabilityTool<In, Out>> = {}): CapabilityTool<In, Out> {
  const validate = (raw: unknown): ValidationResult<In> => {
    if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['must be object'] }
    const n = (raw as Record<string, unknown>).n
    if (typeof n !== 'number') return { ok: false, errors: ['n must be a number'] }
    return { ok: true, value: { n } }
  }

  return {
    name: 'double',
    description: 'Doubles n.',
    riskTier: 'read-only',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    validateInput: validate,
    handler: (input) => ({ doubled: input.n * 2 }),
    ...overrides
  }
}

describe('fromCapabilityTool', () => {
  it('copies name/description/input schema from the tool', () => {
    const tool = makeTool()
    const descriptor = fromCapabilityTool(tool)
    expect(descriptor.name).toBe('double')
    expect(descriptor.description).toBe('Doubles n.')
    expect(descriptor.input).toBe(tool.inputSchema)
    expect(descriptor.riskTier).toBe('read-only')
  })

  it('runs validateInput then handler and serializes the output as content', async () => {
    const handler = vi.fn((input: In) => ({ doubled: input.n * 2 }))
    const descriptor = fromCapabilityTool(makeTool({ handler }))
    const result = await descriptor.execute({ n: 21 })

    expect(handler).toHaveBeenCalledWith({ n: 21 })
    expect(JSON.parse(result.content)).toEqual({ doubled: 42 })
  })

  it('rejects hostile input with structured errors and never calls handler', async () => {
    const handler = vi.fn((input: In) => ({ doubled: input.n * 2 }))
    const descriptor = fromCapabilityTool(makeTool({ handler }))
    const result = await descriptor.execute({ n: 'nope' })

    expect(handler).not.toHaveBeenCalled()
    const parsed = JSON.parse(result.content)
    expect(parsed.status).toBe('error')
    expect(parsed.tool).toBe('double')
    expect(parsed.errors).toContain('n must be a number')
  })

  it('catches a thrown handler and reports it as error content (never rejects)', async () => {
    const descriptor = fromCapabilityTool(
      makeTool({
        handler: () => {
          throw new Error('boom')
        }
      })
    )
    const result = await descriptor.execute({ n: 1 })
    const parsed = JSON.parse(result.content)
    expect(parsed.status).toBe('error')
    expect(parsed.reason).toBe('boom')
  })

  it('stays JSON-serializable even when the handler returns a cyclic object', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const descriptor = fromCapabilityTool(
      makeTool({ handler: () => cyclic as unknown as Out })
    )
    const result = await descriptor.execute({ n: 1 })
    const parsed = JSON.parse(result.content)
    expect(parsed.status).toBe('error')
  })

  it('omits output when the tool declares no outputSchema', async () => {
    const descriptor = fromCapabilityTool(makeTool())
    expect(descriptor.output).toBeUndefined()
    const result = await descriptor.execute({ n: 2 })
    expect(result.output).toBeUndefined()
  })

  it('declares outputSchema and returns the handler value as output', async () => {
    const outputSchema = { type: 'object', properties: { doubled: { type: 'number' } } }
    const descriptor = fromCapabilityTool(makeTool({ outputSchema }))
    expect(descriptor.output).toBe(outputSchema)

    const result = await descriptor.execute({ n: 5 })
    expect(result.output).toEqual({ doubled: 10 })
    expect(JSON.parse(result.content)).toEqual({ doubled: 10 })
  })

  it('does not emit output for invalid input even when an outputSchema is declared', async () => {
    const descriptor = fromCapabilityTool(
      makeTool({ outputSchema: { type: 'object' } })
    )
    const result = await descriptor.execute({ n: 'bad' })
    expect(result.output).toBeUndefined()
    expect(JSON.parse(result.content).status).toBe('error')
  })
})
