import { describe, expect, it } from 'vitest'

import { anyValue, arrOf, bool, enumOf, nullable, num, obj, objOf, str } from './schema'

describe('schema DSL', () => {
  it('emits primitive field schemas with descriptions', () => {
    expect(str('a string')).toEqual({ type: 'string', description: 'a string' })
    expect(num('a number')).toEqual({ type: 'number', description: 'a number' })
    expect(bool('a bool')).toEqual({ type: 'boolean', description: 'a bool' })
  })

  it('emits enum fields with a copied value list', () => {
    const values = ['a', 'b'] as const
    expect(enumOf(values, 'pick one')).toEqual({
      type: 'string',
      enum: ['a', 'b'],
      description: 'pick one'
    })
  })

  it('emits array fields wrapping an item schema', () => {
    expect(arrOf(str('item'), 'many')).toEqual({
      type: 'array',
      description: 'many',
      items: { type: 'string', description: 'item' }
    })
  })

  it('emits closed objects with required and additionalProperties:false', () => {
    const schema = obj({ n: num('n') }, ['n'])
    expect(schema).toEqual({
      type: 'object',
      properties: { n: { type: 'number', description: 'n' } },
      required: ['n'],
      additionalProperties: false
    })
  })

  it('emits free-form objects that allow additional keys', () => {
    const schema = objOf('map', { additionalProperties: { type: 'string' } })
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toEqual({ type: 'string' })
  })

  it('emits an accept-anything schema for opaque blobs', () => {
    expect(anyValue('whatever')).toEqual({ description: 'whatever' })
  })

  it('widens a typed schema to allow null', () => {
    expect(nullable(str('maybe'))).toEqual({
      type: ['string', 'null'],
      description: 'maybe'
    })
  })

  it('falls back to anyOf for schemas without a scalar type', () => {
    const schema = nullable({ anyOf: [{ type: 'string' }] })
    expect(schema).toEqual({ anyOf: [{ anyOf: [{ type: 'string' }] }, { type: 'null' }] })
  })
})
