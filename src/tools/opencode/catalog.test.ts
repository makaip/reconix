import { describe, expect, it } from 'vitest'

import { createMockToolRegistry } from '../registry'
import { registerCustomTools } from '../index'
import { capabilityLoaders } from './catalog'

describe('capabilityLoaders catalog', () => {
  it('every loader resolves to a capability tool', async () => {
    const tools = await Promise.all(capabilityLoaders.map((load) => load()))
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
      expect(typeof tool.validateInput).toBe('function')
      expect(typeof tool.handler).toBe('function')
      expect(tool.inputSchema).toBeTypeOf('object')
    }
  })

  it('tool names are unique across the catalog', async () => {
    const tools = await Promise.all(capabilityLoaders.map((load) => load()))
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('the catalog covers exactly the tools registered by registerCustomTools', async () => {
    const registry = createMockToolRegistry()
    registerCustomTools(registry)
    const registered = new Set(registry.list().map((t) => t.name))

    const loaded = new Set((await Promise.all(capabilityLoaders.map((load) => load()))).map((t) => t.name))

    expect(loaded).toEqual(registered)
  })

  it('every registered capability tool carries a declarative inputSchema', async () => {
    const tools = await Promise.all(capabilityLoaders.map((load) => load()))
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeTruthy()
      expect((tool.inputSchema as { type?: string }).type).toBe('object')
    }
  })

  it('every registered capability tool declares an outputSchema', async () => {
    const tools = await Promise.all(capabilityLoaders.map((load) => load()))
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} missing outputSchema`).toBeTruthy()
    }
  })
})
