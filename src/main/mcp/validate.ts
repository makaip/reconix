// Minimal "validate as hostile" helpers (ARCHITECTURE §5.C rule 2).
// Each tool hand-writes a parse() using these. In production the JSON Schema
// on each tool should be compiled with ajv and used as the single source of
// truth; these guards keep the skeleton dependency-free and explicit.

import { ToolInputError } from './errors'

export type JsonSchema = Record<string, unknown>

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ToolInputError('expected an object')
  }
  return raw as Record<string, unknown>
}

export function str(raw: unknown, key: string): string {
  const v = asRecord(raw)[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolInputError(`"${key}" must be a non-empty string`)
  }
  return v
}

export function optStr(raw: unknown, key: string): string | undefined {
  const v = asRecord(raw)[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string`)
  return v
}

export function num(raw: unknown, key: string): number {
  const v = asRecord(raw)[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ToolInputError(`"${key}" must be a finite number`)
  }
  return v
}

export function bool(raw: unknown, key: string, fallback = false): boolean {
  const v = asRecord(raw)[key]
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') throw new ToolInputError(`"${key}" must be a boolean`)
  return v
}

export function strArray(raw: unknown, key: string): string[] {
  const v = asRecord(raw)[key]
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
    throw new ToolInputError(`"${key}" must be an array of strings`)
  }
  return v as string[]
}

export function enumOf<T extends string>(raw: unknown, key: string, allowed: readonly T[]): T {
  const v = str(raw, key)
  if (!(allowed as readonly string[]).includes(v)) {
    throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}`)
  }
  return v as T
}

// http/https only — anything else is rejected before it can reach the target.
export function urlString(raw: unknown, key: string): string {
  const v = str(raw, key)
  let parsed: URL
  try {
    parsed = new URL(v)
  } catch {
    throw new ToolInputError(`"${key}" is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolInputError(`"${key}" must be http(s)`)
  }
  return parsed.href
}
