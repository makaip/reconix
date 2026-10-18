// Minimal JSON-Schema builder DSL for the capability tools (§5.E / §6.2).
//
// §6.2 describes the tool contract shape as
// `{ name, description, inputSchema, outputSchema, riskTier }`. This module
// provides the tiny, dependency-free builders used to author `inputSchema` on
// each `CapabilityTool` so the OpenCode adapter can expose an accurate input
// schema WITHOUT pulling in JSON-Schema or zod (per the task constraints).
//
// These builders only ever emit plain JSON Schema objects consumed by the
// OpenCode tool runtime; they are not a validator. The runtime gate remains
// each tool's hand-rolled `validateInput`.

/** A plain JSON Schema object (kept loose on purpose — no schema lib). */
export type JsonSchema = Record<string, unknown>

/** A JSON string field. */
export function str(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: 'string', description, ...extra }
}

/** A JSON number field. */
export function num(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: 'number', description, ...extra }
}

/** A JSON boolean field. */
export function bool(description: string): JsonSchema {
  return { type: 'boolean', description }
}

/** A JSON array field with a single homogeneous `items` schema. */
export function arrOf(items: JsonSchema, description: string): JsonSchema {
  return { type: 'array', description, items }
}

/** A JSON string field constrained to a fixed set of values. */
export function enumOf(values: readonly string[], description: string): JsonSchema {
  return { type: 'string', enum: [...values], description }
}

/** A free-form object field (arbitrary keys). */
export function objOf(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: 'object', description, additionalProperties: true, ...extra }
}

/** A JSON object field with declared properties and a fixed `required` set. */
export function obj(
  properties: Record<string, JsonSchema>,
  required: string[] = []
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  }
}

/** A schema that accepts any JSON value (used for opaque, caller-supplied blobs). */
export function anyValue(description: string): JsonSchema {
  return { description }
}

/** A field that may also be JSON `null` (e.g. `string | null`). */
export function nullable(schema: JsonSchema): JsonSchema {
  const t = schema.type
  if (typeof t === 'string') return { ...schema, type: [t, 'null'] }
  return { anyOf: [schema, { type: 'null' }] }
}
