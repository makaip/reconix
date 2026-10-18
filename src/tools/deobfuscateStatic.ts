// deobfuscate_static — ARCHITECTURE.MD §5.E / Dev 1 capability tool.
//
// Pure-compute static JavaScript deobfuscator. It parses untrusted JS and
// rewrites common obfuscation into readable form, then reports what it found.
//
// Safety posture (why this file looks the way it does):
//   1. The untrusted script is NEVER executed. There is no `eval`/`Function`
//      anywhere in this module. Decoder functions, string-array rotations and
//      other resolver logic are replayed inside a bounded, confined AST
//      interpreter that only knows a small allowlist of pure builtins and
//      isolated fake globals — it has no DOM, no network, no filesystem and
//      no way to reach the real process.
//   2. Every evaluation is bounded by a step budget (STEP_LIMIT) and every
//      pass by a structural cap, so a hostile `while(true)` packer/rotator
//      cannot hang the caller.
//   3. Unsupported constructs fail CLOSED: a decoder built on something the
//      interpreter cannot model is left untouched and noted, never silently
//      half-solved into a wrong answer.
//   4. The engine is self-contained (its own input/output types) so the
//      OpenCode plugin can reuse it directly; only the generic CapabilityTool
//      contract is imported from ../shared/tools.

import { parse } from 'acorn'
import { generate } from 'astring'

import type { CapabilityTool, ValidationResult } from '../shared/tools'
import { arrOf, bool, enumOf, num, obj, objOf, str } from './schema'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeobfuscateTechnique =
  | 'constant-fold'
  | 'string-array-unpack'
  | 'decoder-chain'
  | 'eval-packer-unpack'
  | 'simplify'
  | 'rename'
  | 'dead-code'

export const DEOBFUSCATE_TECHNIQUES: readonly DeobfuscateTechnique[] = [
  'constant-fold',
  'string-array-unpack',
  'decoder-chain',
  'eval-packer-unpack',
  'simplify',
  'rename',
  'dead-code'
]

export type DeobfuscateStaticInput = {
  source: string
  techniques?: DeobfuscateTechnique[]
  maxOutputBytes?: number
}

export type DeobfuscateStaticPass = {
  name: string
  changed: boolean
  note?: string
}

export type DeobfuscateStaticMetrics = {
  inputBytes: number
  outputBytes: number
  entropyBefore: number
  entropyAfter: number
  identifierManglingRatio: number
  evalCount: number
  stringArraySize: number
}

export type DeobfuscateStaticFamily = { name: string; confidence: number }

export type DeobfuscateStaticOutput = {
  status: 'ok' | 'partial' | 'error'
  family: DeobfuscateStaticFamily
  transformed: string
  truncated: boolean
  metrics: DeobfuscateStaticMetrics
  passes: DeobfuscateStaticPass[]
  indicators: { urls: string[]; domains: string[]; stringLiterals: string[] }
  notes: string[]
}

// ---------------------------------------------------------------------------
// Caps / constants
// ---------------------------------------------------------------------------

const MAX_SOURCE_LENGTH = 5_000_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const STEP_LIMIT = 400_000
const MAX_INDICATORS = 200
const MIN_STRING_ARRAY_LENGTH = 5

// ---------------------------------------------------------------------------
// Validation (input is hostile, §5.C rule 2)
// ---------------------------------------------------------------------------

function validate(raw: unknown): ValidationResult<DeobfuscateStaticInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const obj = raw as Record<string, unknown>

  if (typeof obj.source !== 'string') {
    return { ok: false, errors: ['source must be a string'] }
  }
  if (obj.source.length === 0) {
    return { ok: false, errors: ['source must not be empty'] }
  }
  if (obj.source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, errors: [`source must be <= ${MAX_SOURCE_LENGTH} chars`] }
  }

  let techniques: DeobfuscateTechnique[] | undefined
  if (obj.techniques !== undefined) {
    if (!Array.isArray(obj.techniques)) {
      return { ok: false, errors: ['techniques must be an array'] }
    }
    const out: DeobfuscateTechnique[] = []
    for (const t of obj.techniques) {
      if (typeof t !== 'string' || !DEOBFUSCATE_TECHNIQUES.includes(t as DeobfuscateTechnique)) {
        return { ok: false, errors: [`unknown technique: ${String(t)}`] }
      }
      out.push(t as DeobfuscateTechnique)
    }
    techniques = out
  }

  let maxOutputBytes: number | undefined
  if (obj.maxOutputBytes !== undefined) {
    if (
      typeof obj.maxOutputBytes !== 'number' ||
      !Number.isFinite(obj.maxOutputBytes) ||
      obj.maxOutputBytes <= 0
    ) {
      return { ok: false, errors: ['maxOutputBytes must be a positive finite number'] }
    }
    maxOutputBytes = Math.floor(obj.maxOutputBytes)
  }

  return { ok: true, value: { source: obj.source, techniques, maxOutputBytes } }
}

// ---------------------------------------------------------------------------
// AST plumbing
// ---------------------------------------------------------------------------

type AstNode = { type: string; [key: string]: any }

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as any).type === 'string'
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range'])

/** Depth-first walk in document order, visiting every AST node. */
function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node)
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const value = node[key]
    if (isNode(value)) walk(value, visit)
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit)
    }
  }
}

/** Walk with parent + property-key context (used for reference counting/rename). */
function walkWithParents(
  node: AstNode,
  parent: AstNode | null,
  key: string | null,
  visit: (n: AstNode, parent: AstNode | null, key: string | null) => void
): void {
  visit(node, parent, key)
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue
    const value = node[k]
    if (isNode(value)) walkWithParents(value, node, k, visit)
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walkWithParents(item, node, k, visit)
    }
  }
}

/**
 * Post-order transform: children are visited before their parent, and `fn`
 * may return a replacement node (or null to leave the node unchanged).
 */
function transform(node: AstNode, fn: (n: AstNode) => AstNode | null): AstNode {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (isNode(value[i])) {
          const replaced = transform(value[i], fn)
          if (replaced !== value[i]) value[i] = replaced
        }
      }
    } else if (isNode(value)) {
      const replaced = transform(value, fn)
      if (replaced !== value) node[key] = replaced
    }
  }
  return fn(node) ?? node
}

function parseProgram(code: string): AstNode {
  const opts = {
    ecmaVersion: 'latest',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
    locations: false
  }
  try {
    return parse(code, { ...opts, sourceType: 'script' } as any) as unknown as AstNode
  } catch {
    return parse(code, { ...opts, sourceType: 'module' } as any) as unknown as AstNode
  }
}

// ---------------------------------------------------------------------------
// Confined AST interpreter (NO eval / NO Function)
// ---------------------------------------------------------------------------

type Scope = { vars: Map<string, unknown>; parent: Scope | null }

function makeScope(parent: Scope | null): Scope {
  return { vars: new Map(), parent }
}

function scopeLookup(scope: Scope | null, name: string): { found: boolean; value: unknown } {
  let s = scope
  while (s) {
    if (s.vars.has(name)) return { found: true, value: s.vars.get(name) }
    s = s.parent
  }
  return { found: false, value: undefined }
}

type NativeFn = { __native: (args: unknown[]) => unknown }
type UserFn = { __fn: AstNode }

function isNativeFn(v: unknown): v is NativeFn {
  return typeof v === 'object' && v !== null && typeof (v as any).__native === 'function'
}
function isUserFn(v: unknown): v is UserFn {
  return typeof v === 'object' && v !== null && (v as any).__fn !== undefined
}

class InterpUnsupported extends Error {}
class ReturnSignal {
  constructor(readonly value: unknown) {}
}
class BreakSignal {}
class ContinueSignal {}

type InterpCtx = { steps: number; stepLimit: number }

function tick(ctx: InterpCtx): void {
  ctx.steps++
  if (ctx.steps > ctx.stepLimit) throw new InterpUnsupported('step limit exceeded')
}

function decodeBase64(s: string): string {
  return Buffer.from(s, 'base64').toString('binary')
}
function encodeBase64(s: string): string {
  return Buffer.from(s, 'binary').toString('base64')
}
function jsUnescape(s: string): string {
  return s.replace(/%u([0-9a-fA-F]{4})|%([0-9a-fA-F]{2})/g, (_m, u, h) =>
    String.fromCharCode(parseInt(u ?? h, 16))
  )
}
function jsEscape(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (/[A-Za-z0-9@*_+\-./]/.test(ch)) out += ch
    else if (ch === ' ') out += '+'
    else if (code < 256) out += '%' + code.toString(16).padStart(2, '0').toUpperCase()
    else out += '%u' + code.toString(16).padStart(4, '0').toUpperCase()
  }
  return out
}

const BUILTIN_FNS: Record<string, (args: unknown[]) => unknown> = {
  parseInt: (a) => parseInt(String(a[0]), typeof a[1] === 'number' ? (a[1] as number) : undefined),
  parseFloat: (a) => parseFloat(String(a[0])),
  String: (a) => (a.length === 0 ? '' : String(a[0])),
  Number: (a) => Number(a[0]),
  Boolean: (a) => Boolean(a[0]),
  atob: (a) => decodeBase64(String(a[0])),
  btoa: (a) => encodeBase64(String(a[0])),
  unescape: (a) => jsUnescape(String(a[0])),
  escape: (a) => jsEscape(String(a[0])),
  decodeURIComponent: (a) => decodeURIComponent(String(a[0])),
  encodeURIComponent: (a) => encodeURIComponent(String(a[0]))
}

const NAMESPACE_METHODS: Record<string, Record<string, (args: unknown[]) => unknown>> = {
  String: {
    fromCharCode: (a) => String.fromCharCode(...a.map((x) => Number(x))),
    fromCodePoint: (a) => String.fromCodePoint(...a.map((x) => Number(x)))
  },
  Math: {
    floor: (a) => Math.floor(Number(a[0])),
    ceil: (a) => Math.ceil(Number(a[0])),
    round: (a) => Math.round(Number(a[0])),
    abs: (a) => Math.abs(Number(a[0])),
    pow: (a) => Math.pow(Number(a[0]), Number(a[1])),
    min: (a) => Math.min(...a.map(Number)),
    max: (a) => Math.max(...a.map(Number))
  },
  Array: {
    isArray: (a) => Array.isArray(a[0])
  }
}

function builtinScope(): Scope {
  const scope = makeScope(null)
  for (const [name, fn] of Object.entries(BUILTIN_FNS)) {
    scope.vars.set(name, { __native: fn } satisfies NativeFn)
  }
  return scope
}

function propName(member: AstNode): string | null {
  if (!member.computed && member.property?.type === 'Identifier') return member.property.name
  if (member.computed && member.property?.type === 'Literal') return String(member.property.value)
  return null
}

function getMember(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined
  if (typeof obj === 'string') {
    if (key === 'length') return obj.length
    const i = Number(key)
    return Number.isInteger(i) ? obj[i] : undefined
  }
  if (Array.isArray(obj)) {
    if (key === 'length') return obj.length
    const i = Number(key)
    return Number.isInteger(i) ? obj[i] : (obj as any)[key]
  }
  if (typeof obj === 'object') return (obj as any)[key]
  return undefined
}

function setMember(obj: unknown, key: string, value: unknown): void {
  if (Array.isArray(obj)) {
    const i = Number(key)
    if (Number.isInteger(i)) obj[i] = value
    return
  }
  if (typeof obj === 'object' && obj !== null) (obj as any)[key] = value
}

function callMethod(obj: unknown, prop: string, args: unknown[]): unknown {
  if (typeof obj === 'string') {
    switch (prop) {
      case 'charCodeAt':
        return obj.charCodeAt(Number(args[0] ?? 0))
      case 'codePointAt':
        return obj.codePointAt(Number(args[0] ?? 0))
      case 'charAt':
        return obj.charAt(Number(args[0] ?? 0))
      case 'slice':
        return obj.slice(Number(args[0] ?? 0), args.length > 1 ? Number(args[1]) : undefined)
      case 'substring':
        return obj.substring(Number(args[0] ?? 0), args.length > 1 ? Number(args[1]) : undefined)
      case 'substr':
        return obj.substr(Number(args[0] ?? 0), args.length > 1 ? Number(args[1]) : undefined)
      case 'split':
        return obj.split(String(args[0]))
      case 'indexOf':
        return obj.indexOf(String(args[0]))
      case 'includes':
        return obj.includes(String(args[0]))
      case 'toLowerCase':
        return obj.toLowerCase()
      case 'toUpperCase':
        return obj.toUpperCase()
      case 'trim':
        return obj.trim()
      case 'concat':
        return obj.concat(...args.map(String))
      case 'repeat':
        return obj.repeat(Number(args[0] ?? 0))
      case 'replace':
        if (typeof args[0] === 'string') return obj.split(String(args[0])).join(String(args[1]))
        throw new InterpUnsupported('String.replace with non-string pattern')
      case 'toString':
        return obj
      default:
        throw new InterpUnsupported(`String.${prop}`)
    }
  }
  if (Array.isArray(obj)) {
    switch (prop) {
      case 'join':
        return obj.join(args.length ? String(args[0]) : ',')
      case 'push':
        return obj.push(...args)
      case 'pop':
        return obj.pop()
      case 'shift':
        return obj.shift()
      case 'unshift':
        return obj.unshift(...args)
      case 'reverse':
        return obj.reverse()
      case 'slice':
        return obj.slice(Number(args[0] ?? 0), args.length > 1 ? Number(args[1]) : undefined)
      case 'concat':
        return obj.concat(...(args as any[]))
      case 'indexOf':
        return obj.indexOf(args[0])
      case 'includes':
        return obj.includes(args[0])
      case 'toString':
        return obj.join(',')
      default:
        throw new InterpUnsupported(`Array.${prop}`)
    }
  }
  if (typeof obj === 'number') {
    if (prop === 'toString')
      return obj.toString(typeof args[0] === 'number' ? (args[0] as number) : 10)
    if (prop === 'valueOf') return obj
  }
  throw new InterpUnsupported(`method ${prop} on ${typeof obj}`)
}

function evalNode(node: AstNode, scope: Scope, ctx: InterpCtx, pure: boolean): unknown {
  tick(ctx)
  switch (node.type) {
    case 'Literal':
      if (node.regex) throw new InterpUnsupported('regex literal')
      return node.value

    case 'Identifier': {
      if (pure) throw new InterpUnsupported('identifier under pure eval')
      if (node.name === 'undefined') return undefined
      if (node.name === 'NaN') return NaN
      if (node.name === 'Infinity') return Infinity
      const r = scopeLookup(scope, node.name)
      if (!r.found) throw new InterpUnsupported(`unknown identifier ${node.name}`)
      return r.value
    }

    case 'ThisExpression':
      return undefined

    case 'TemplateLiteral': {
      let out = ''
      for (let i = 0; i < node.quasis.length; i++) {
        out += node.quasis[i].value.cooked
        if (i < node.expressions.length) {
          out += String(evalNode(node.expressions[i], scope, ctx, pure))
        }
      }
      return out
    }

    case 'UnaryExpression': {
      const v = evalNode(node.argument, scope, ctx, pure)
      switch (node.operator) {
        case '-':
          return -Number(v)
        case '+':
          return +Number(v)
        case '!':
          return !v
        case '~':
          return ~Number(v)
        case 'void':
          return undefined
        case 'typeof':
          return typeof v
        default:
          throw new InterpUnsupported(`unary ${node.operator}`)
      }
    }

    case 'BinaryExpression': {
      const l = evalNode(node.left, scope, ctx, pure)
      const r = evalNode(node.right, scope, ctx, pure)
      switch (node.operator) {
        case '+':
          if (typeof l === 'string' || typeof r === 'string') return String(l) + String(r)
          return Number(l) + Number(r)
        case '-':
          return Number(l) - Number(r)
        case '*':
          return Number(l) * Number(r)
        case '/':
          return Number(l) / Number(r)
        case '%':
          return Number(l) % Number(r)
        case '**':
          return Number(l) ** Number(r)
        case '==':
          return (l as any) == (r as any) // eslint-disable-line eqeqeq
        case '!=':
          return (l as any) != (r as any) // eslint-disable-line eqeqeq
        case '===':
          return l === r
        case '!==':
          return l !== r
        case '<':
          return (l as any) < (r as any)
        case '<=':
          return (l as any) <= (r as any)
        case '>':
          return (l as any) > (r as any)
        case '>=':
          return (l as any) >= (r as any)
        case '&':
          return Number(l) & Number(r)
        case '|':
          return Number(l) | Number(r)
        case '^':
          return Number(l) ^ Number(r)
        case '<<':
          return Number(l) << Number(r)
        case '>>':
          return Number(l) >> Number(r)
        case '>>>':
          return Number(l) >>> Number(r)
        default:
          throw new InterpUnsupported(`binary ${node.operator}`)
      }
    }

    case 'LogicalExpression': {
      const l = evalNode(node.left, scope, ctx, pure)
      if (node.operator === '&&') return l ? evalNode(node.right, scope, ctx, pure) : l
      if (node.operator === '||') return l ? l : evalNode(node.right, scope, ctx, pure)
      if (node.operator === '??') return l ?? evalNode(node.right, scope, ctx, pure)
      throw new InterpUnsupported(`logical ${node.operator}`)
    }

    case 'ConditionalExpression':
      return evalNode(node.test, scope, ctx, pure)
        ? evalNode(node.consequent, scope, ctx, pure)
        : evalNode(node.alternate, scope, ctx, pure)

    case 'SequenceExpression': {
      let result: unknown
      for (const e of node.expressions) result = evalNode(e, scope, ctx, pure)
      return result
    }

    case 'ArrayExpression': {
      const out: unknown[] = []
      for (const el of node.elements) out.push(el === null ? undefined : evalNode(el, scope, ctx, pure))
      return out
    }

    case 'ObjectExpression': {
      const out: Record<string, unknown> = {}
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.kind !== 'init') throw new InterpUnsupported('object property')
        const key = p.computed
          ? String(evalNode(p.key, scope, ctx, pure))
          : p.key.type === 'Identifier'
            ? p.key.name
            : String(p.key.value)
        out[key] = evalNode(p.value, scope, ctx, pure)
      }
      return out
    }

    case 'MemberExpression': {
      const obj = evalNode(node.object, scope, ctx, pure)
      const key = node.computed
        ? String(evalNode(node.property, scope, ctx, pure))
        : node.property.type === 'Identifier'
          ? node.property.name
          : ''
      return getMember(obj, key)
    }

    case 'CallExpression': {
      if (pure) throw new InterpUnsupported('call under pure eval')
      return evalCall(node, scope, ctx)
    }

    case 'AssignmentExpression': {
      if (pure) throw new InterpUnsupported('assignment under pure eval')
      const value = evalNode(node.right, scope, ctx, pure)
      assignTarget(node.left, value, scope, ctx)
      return value
    }

    case 'UpdateExpression': {
      if (pure) throw new InterpUnsupported('update under pure eval')
      const old = readTarget(node.argument, scope, ctx)
      const next = node.operator === '++' ? Number(old) + 1 : Number(old) - 1
      assignTarget(node.argument, next, scope, ctx)
      return node.prefix ? next : old
    }

    default:
      throw new InterpUnsupported(`expression ${node.type}`)
  }
}

function evalCall(node: AstNode, scope: Scope, ctx: InterpCtx): unknown {
  const args = node.arguments.map((a: AstNode) => evalNode(a, scope, ctx, false))
  const callee = node.callee

  // Immediately-invoked function expressions (rotation wrappers, etc.).
  if (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression') {
    return interpretFunction(callee, args, scope, ctx)
  }

  if (callee.type === 'Identifier') {
    const r = scopeLookup(scope, callee.name)
    if (r.found) {
      if (isUserFn(r.value)) return interpretFunction(r.value.__fn, args, scope, ctx)
      if (isNativeFn(r.value)) return r.value.__native(args)
      throw new InterpUnsupported(`callee not callable: ${callee.name}`)
    }
    const builtin = BUILTIN_FNS[callee.name]
    if (builtin) return builtin(args)
    throw new InterpUnsupported(`unknown callee ${callee.name}`)
  }

  if (callee.type === 'MemberExpression') {
    if (callee.object.type === 'Identifier') {
      const ns = NAMESPACE_METHODS[callee.object.name]
      const prop = propName(callee)
      if (ns && prop && ns[prop]) return ns[prop](args)
    }
    const obj = evalNode(callee.object, scope, ctx, false)
    const prop = propName(callee)
    if (prop === null) throw new InterpUnsupported('computed method name')
    return callMethod(obj, prop, args)
  }

  throw new InterpUnsupported('unsupported callee shape')
}

function readTarget(node: AstNode, scope: Scope, ctx: InterpCtx): unknown {
  if (node.type === 'Identifier') return scopeLookup(scope, node.name).value
  if (node.type === 'MemberExpression') {
    const obj = evalNode(node.object, scope, ctx, false)
    const key = node.computed
      ? String(evalNode(node.property, scope, ctx, false))
      : node.property.name
    return getMember(obj, key)
  }
  throw new InterpUnsupported('read target')
}

function assignTarget(node: AstNode, value: unknown, scope: Scope, ctx: InterpCtx): void {
  if (node.type === 'Identifier') {
    scope.vars.set(node.name, value)
    return
  }
  if (node.type === 'MemberExpression') {
    const obj = evalNode(node.object, scope, ctx, false)
    const key = node.computed
      ? String(evalNode(node.property, scope, ctx, false))
      : node.property.name
    setMember(obj, key, value)
    return
  }
  throw new InterpUnsupported('assign target')
}

function bindDecl(id: AstNode, value: unknown, scope: Scope): void {
  if (id.type === 'Identifier') {
    scope.vars.set(id.name, value)
    return
  }
  throw new InterpUnsupported('binding pattern')
}

function hoistFunctions(statements: AstNode[], scope: Scope): void {
  for (const stmt of statements) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      scope.vars.set(stmt.id.name, { __fn: stmt } satisfies UserFn)
    }
  }
}

function execStatements(statements: AstNode[], scope: Scope, ctx: InterpCtx): void {
  for (const stmt of statements) execStmt(stmt, scope, ctx)
}

function execStmt(node: AstNode, scope: Scope, ctx: InterpCtx): void {
  tick(ctx)
  switch (node.type) {
    case 'VariableDeclaration': {
      for (const d of node.declarations) {
        const value = d.init ? evalNode(d.init, scope, ctx, false) : undefined
        bindDecl(d.id, value, scope)
      }
      return
    }
    case 'ExpressionStatement':
      evalNode(node.expression, scope, ctx, false)
      return
    case 'ReturnStatement':
      throw new ReturnSignal(node.argument ? evalNode(node.argument, scope, ctx, false) : undefined)
    case 'BlockStatement':
      execStatements(node.body, makeScope(scope), ctx)
      return
    case 'IfStatement': {
      if (evalNode(node.test, scope, ctx, false)) execStmt(node.consequent, scope, ctx)
      else if (node.alternate) execStmt(node.alternate, scope, ctx)
      return
    }
    case 'WhileStatement': {
      while (evalNode(node.test, scope, ctx, false)) {
        tick(ctx)
        try {
          execStmt(node.body, scope, ctx)
        } catch (e) {
          if (e instanceof ContinueSignal) continue
          if (e instanceof BreakSignal) break
          throw e
        }
      }
      return
    }
    case 'ForStatement': {
      if (node.init) {
        if (node.init.type === 'VariableDeclaration') execStmt(node.init, scope, ctx)
        else evalNode(node.init, scope, ctx, false)
      }
      while (node.test ? Boolean(evalNode(node.test, scope, ctx, false)) : true) {
        tick(ctx)
        let broke = false
        try {
          if (node.body) execStmt(node.body, scope, ctx)
        } catch (e) {
          if (e instanceof ContinueSignal) {
            // fall through to update
          } else if (e instanceof BreakSignal) {
            broke = true
          } else {
            throw e
          }
        }
        if (broke) break
        if (node.update) evalNode(node.update, scope, ctx, false)
      }
      return
    }
    case 'FunctionDeclaration':
      if (node.id) scope.vars.set(node.id.name, { __fn: node } satisfies UserFn)
      return
    case 'EmptyStatement':
    case 'DebuggerStatement':
      return
    case 'TryStatement': {
      try {
        execStmt(node.block, scope, ctx)
      } catch (e) {
        if (
          e instanceof ReturnSignal ||
          e instanceof BreakSignal ||
          e instanceof ContinueSignal ||
          e instanceof InterpUnsupported
        ) {
          throw e
        }
        if (node.handler) {
          const hs = makeScope(scope)
          if (node.handler.param?.type === 'Identifier') hs.vars.set(node.handler.param.name, e)
          execStmt(node.handler.body, hs, ctx)
        }
      }
      return
    }
    case 'SwitchStatement': {
      const disc = evalNode(node.discriminant, scope, ctx, false)
      let matched = false
      for (const c of node.cases) {
        if (!matched) {
          if (c.test === null || evalNode(c.test, scope, ctx, false) === disc) matched = true
        }
        if (matched) {
          try {
            execStatements(c.consequent, scope, ctx)
          } catch (e) {
            if (e instanceof BreakSignal) return
            throw e
          }
        }
      }
      return
    }
    case 'BreakStatement':
      throw new BreakSignal()
    case 'ContinueStatement':
      throw new ContinueSignal()
    default:
      throw new InterpUnsupported(`statement ${node.type}`)
  }
}

function interpretFunction(
  fnNode: AstNode,
  args: unknown[],
  callerScope: Scope,
  ctx: InterpCtx
): unknown {
  const scope = makeScope(callerScope)
  const params: AstNode[] = fnNode.params ?? []
  for (let i = 0; i < params.length; i++) {
    if (params[i].type !== 'Identifier') throw new InterpUnsupported('parameter pattern')
    scope.vars.set(params[i].name, args[i])
  }
  scope.vars.set('arguments', args)
  const bodyStatements: AstNode[] =
    fnNode.body.type === 'BlockStatement' ? fnNode.body.body : [fnNode.body]
  hoistFunctions(bodyStatements, scope)
  try {
    execStatements(bodyStatements, scope, ctx)
  } catch (e) {
    if (e instanceof ReturnSignal) return e.value
    throw e
  }
  return undefined
}

/**
 * Build an evaluation scope from the program: registers function declarations,
 * then leniently replays top-level statements to capture consts, string arrays
 * and rotation IIFEs that mutate them. Statements that reach anything outside
 * the confined interpreter (DOM, network, unknown globals) are skipped, not
 * fatal — we only need the pure data-flow.
 *
 * `tainted` lists identifiers referenced by statements we could NOT fully
 * replay. A string array whose name is tainted may have been left half-rotated,
 * so callers must refuse to resolve it (fail closed) rather than emit values
 * computed from a partially executed rotation.
 */
function buildEnv(program: AstNode): { scope: Scope; tainted: Set<string> } {
  const ctx: InterpCtx = { steps: 0, stepLimit: STEP_LIMIT }
  const scope = builtinScope()
  const tainted = new Set<string>()

  // Functions are hoisted regardless of where they are declared, so a decoder
  // defined inside a wrapper is still callable by name.
  const allFunctions: AstNode[] = []
  walk(program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) allFunctions.push(n)
  })
  hoistFunctions(allFunctions, scope)

  for (const stmt of program.body as AstNode[]) {
    if (stmt.type === 'FunctionDeclaration') continue
    try {
      execStmt(stmt, scope, ctx)
    } catch {
      // Best-effort: a statement we cannot model contributes nothing, and any
      // identifier it touched is marked tainted.
      walk(stmt, (n) => {
        if (n.type === 'Identifier') tainted.add(n.name)
      })
    }
  }
  return { scope, tainted }
}

// ---------------------------------------------------------------------------
// Pass helpers
// ---------------------------------------------------------------------------

const EXPR_TYPES = new Set([
  'Literal',
  'TemplateLiteral',
  'UnaryExpression',
  'BinaryExpression',
  'LogicalExpression',
  'ConditionalExpression',
  'SequenceExpression',
  'ArrayExpression',
  'ObjectExpression',
  'MemberExpression'
])

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    v === null
  )
}

function literalNode(value: string | number | boolean | null): AstNode {
  let raw: string
  if (typeof value === 'string') raw = JSON.stringify(value)
  else raw = String(value)
  return { type: 'Literal', value, raw, start: 0, end: 0 }
}

type PassContext = {
  program: AstNode
  env: Scope
  tainted: Set<string>
  evalCtx: InterpCtx
  notes: string[]
}

/** Find variable names bound to an array literal of >= N (mostly) strings. */
function findStringArrays(program: AstNode, env: Scope, evalCtx: InterpCtx): Map<string, string[]> {
  const arrays = new Map<string, string[]>()
  walk(program, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return
    if (n.init?.type !== 'ArrayExpression') return
    if (n.init.elements.length < MIN_STRING_ARRAY_LENGTH) return
    let ok = true
    const values: string[] = []
    for (const el of n.init.elements) {
      if (el === null) {
        values.push('')
        continue
      }
      let v: unknown
      try {
        v = evalNode(el, env, evalCtx, true)
      } catch {
        ok = false
        break
      }
      if (typeof v !== 'string') {
        ok = false
        break
      }
      values.push(v)
    }
    if (ok) arrays.set(n.id.name, values)
  })
  return arrays
}

/** Function names whose body references one of the string-array identifiers. */
function findDecoderFunctions(program: AstNode, arrayNames: Set<string>): Set<string> {
  const decoders = new Set<string>()
  walk(program, (n) => {
    const isFn =
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression'
    if (!isFn) return
    let name: string | null = null
    if (n.type === 'FunctionDeclaration' && n.id) name = n.id.name
    let referencesArray = false
    walk(n.body, (inner) => {
      if (referencesArray) return
      if (inner.type === 'Identifier' && arrayNames.has(inner.name)) referencesArray = true
    })
    if (name && referencesArray) decoders.add(name)
  })

  // Decoders can also be assigned to variables.
  walk(program, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return
    const init = n.init
    if (!init || (init.type !== 'FunctionExpression' && init.type !== 'ArrowFunctionExpression')) return
    let referencesArray = false
    walk(init.body, (inner) => {
      if (!referencesArray && inner.type === 'Identifier' && arrayNames.has(inner.name)) {
        referencesArray = true
      }
    })
    if (referencesArray) decoders.add(n.id.name)
  })

  return decoders
}

// ---------------------------------------------------------------------------
// Dean Edwards packer
// ---------------------------------------------------------------------------

function deanEdwardsUnpack(p: string, a: number, c: number, k: string[]): string {
  const e = (cc: number): string =>
    (cc < a ? '' : e(Math.floor(cc / a))) +
    (cc % a > 35 ? String.fromCharCode((cc % a) + 29) : (cc % a).toString(36))
  let out = p
  while (c--) {
    if (k[c]) out = out.split(new RegExp('\\b' + e(c) + '\\b', 'g')).join(k[c])
  }
  return out
}

function tryUnpackPacker(stmt: AstNode, ctx: PassContext): AstNode[] | null {
  if (stmt.type !== 'ExpressionStatement') return null
  const call = stmt.expression
  if (call?.type !== 'CallExpression') return null
  if (call.callee.type !== 'Identifier' || call.callee.name !== 'eval') return null
  const arg = call.arguments[0]
  if (!arg || arg.type !== 'CallExpression') return null
  if (arg.callee.type !== 'FunctionExpression' && arg.callee.type !== 'ArrowFunctionExpression') {
    return null
  }
  const a = arg.arguments as AstNode[]
  if (a.length < 4) return null

  let p: unknown
  let radix: unknown
  let count: unknown
  let k: unknown
  try {
    p = evalNode(a[0], ctx.env, ctx.evalCtx, false)
    radix = evalNode(a[1], ctx.env, ctx.evalCtx, false)
    count = evalNode(a[2], ctx.env, ctx.evalCtx, false)
    k = evalNode(a[3], ctx.env, ctx.evalCtx, false)
  } catch {
    return null
  }
  if (typeof p !== 'string' || typeof count !== 'number' || !Array.isArray(k)) return null
  const radixN = typeof radix === 'number' ? radix : 62
  const unpacked = deanEdwardsUnpack(p, radixN, count, k.map(String))
  try {
    return parseProgram(unpacked).body as AstNode[]
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Statement-list rewrites (packer unpack, sequence flattening)
// ---------------------------------------------------------------------------

function rewriteStatementLists(
  node: AstNode,
  rewrite: (list: AstNode[]) => AstNode[]
): void {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const value = node[key]
    if (isNode(value)) rewriteStatementLists(value, rewrite)
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) rewriteStatementLists(item, rewrite)
    }
  }
  if ((node.type === 'Program' || node.type === 'BlockStatement') && Array.isArray(node.body)) {
    node.body = rewrite(node.body as AstNode[])
  }
}

// ---------------------------------------------------------------------------
// Reference / declaration analysis (used by rename + dead-code)
// ---------------------------------------------------------------------------

function isDeclarationIdentifier(parent: AstNode | null, key: string | null): boolean {
  if (!parent) return false
  if (parent.type === 'VariableDeclarator' && key === 'id') return true
  if (parent.type === 'FunctionDeclaration' && key === 'id') return true
  if (
    (parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') &&
    key === 'id'
  ) {
    return true
  }
  if (
    key === 'params' &&
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression')
  ) {
    return true
  }
  if (parent.type === 'CatchClause' && key === 'param') return true
  return false
}

function isNonReferenceIdentifier(parent: AstNode | null, key: string | null): boolean {
  if (!parent) return false
  if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return true
  if (parent.type === 'Property' && key === 'key' && !parent.computed) return true
  if (
    (parent.type === 'BreakStatement' ||
      parent.type === 'ContinueStatement' ||
      parent.type === 'LabeledStatement') &&
    key === 'label'
  ) {
    return true
  }
  return false
}

function countReferences(program: AstNode): Map<string, number> {
  const refs = new Map<string, number>()
  walkWithParents(program, null, null, (node, parent, key) => {
    if (node.type !== 'Identifier') return
    if (isDeclarationIdentifier(parent, key) || isNonReferenceIdentifier(parent, key)) return
    refs.set(node.name, (refs.get(node.name) ?? 0) + 1)
  })
  return refs
}

function countDeclarations(program: AstNode): Map<string, number> {
  const decls = new Map<string, number>()
  walkWithParents(program, null, null, (node, parent, key) => {
    if (node.type === 'Identifier' && isDeclarationIdentifier(parent, key)) {
      decls.set(node.name, (decls.get(node.name) ?? 0) + 1)
    }
  })
  return decls
}

function collectIdentifierNames(program: AstNode): Set<string> {
  const names = new Set<string>()
  walk(program, (n) => {
    if (n.type === 'Identifier') names.add(n.name)
  })
  return names
}

// ---------------------------------------------------------------------------
// Indicators / metrics
// ---------------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s'"`<>)\]}\\]+/gi

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of freq.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function collectIndicators(program: AstNode): DeobfuscateStaticOutput['indicators'] {
  const urls = new Set<string>()
  const domains = new Set<string>()
  const strings = new Set<string>()
  walk(program, (n) => {
    let value: string | null = null
    if (n.type === 'Literal' && typeof n.value === 'string') value = n.value
    else if (n.type === 'TemplateElement') value = n.value?.cooked ?? null
    if (value === null) return
    for (const m of value.matchAll(URL_RE)) {
      urls.add(m[0])
      try {
        domains.add(new URL(m[0]).hostname)
      } catch {
        // not a parseable URL; keep the raw match only
      }
    }
    const trimmed = value.trim()
    if (trimmed.length >= 4 && trimmed.length <= 200 && strings.size < MAX_INDICATORS) {
      strings.add(trimmed)
    }
  })
  return {
    urls: [...urls].slice(0, MAX_INDICATORS),
    domains: [...domains].slice(0, MAX_INDICATORS),
    stringLiterals: [...strings].slice(0, MAX_INDICATORS)
  }
}

type PreScan = {
  manglingRatio: number
  evalCount: number
  stringArraySize: number
}

function preScan(program: AstNode): PreScan {
  let identifiers = 0
  let mangled = 0
  let evalCount = 0
  let largestArray = 0
  walk(program, (n) => {
    if (n.type === 'Identifier') {
      identifiers++
      if (/^_0x[0-9a-fA-F]+$/.test(n.name) || n.name.length <= 2) mangled++
    }
    if (
      n.type === 'CallExpression' &&
      n.callee?.type === 'Identifier' &&
      (n.callee.name === 'eval' || n.callee.name === 'Function')
    ) {
      evalCount++
    }
    if (n.type === 'ArrayExpression' && n.elements.length > largestArray) {
      const strings = n.elements.filter(
        (e: AstNode) => e?.type === 'Literal' && typeof e.value === 'string'
      ).length
      if (strings > largestArray) largestArray = strings
    }
  })
  return {
    manglingRatio: identifiers === 0 ? 0 : mangled / identifiers,
    evalCount,
    stringArraySize: largestArray
  }
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

function runConstantFold(ctx: PassContext): boolean {
  const foldScope = builtinScope()
  let changed = false
  ctx.program = transform(ctx.program, (n) => {
    if (!EXPR_TYPES.has(n.type) || n.type === 'Literal') return null
    try {
      const value = evalNode(n, foldScope, ctx.evalCtx, true)
      if (isPrimitive(value)) {
        changed = true
        return literalNode(value)
      }
    } catch {
      // not foldable — leave as-is
    }
    return null
  })
  return changed
}

function runStringArrayUnpack(ctx: PassContext): boolean {
  const arrays = findStringArrays(ctx.program, ctx.env, ctx.evalCtx)
  if (arrays.size === 0) return false
  const arrayNames = new Set(arrays.keys())
  const decoders = findDecoderFunctions(ctx.program, arrayNames)

  // A string array named in a statement we could not fully replay may have been
  // left half-rotated. Resolving it would emit values computed from the wrong
  // order, so we refuse (fail closed) and note it instead.
  const unsafe = [...arrayNames].filter((name) => ctx.tainted.has(name))
  if (unsafe.length > 0) {
    ctx.notes.push(
      `string-array-unpack: skipped ${unsafe.length} array(s) touched by unmodelled code: ${unsafe.join(', ')}`
    )
    return false
  }

  let resolved = 0
  ctx.program = transform(ctx.program, (n) => {
    // Decoder call, e.g. _0xabc(0x12) -> "string"
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && decoders.has(n.callee.name)) {
      try {
        const value = evalNode(n, ctx.env, ctx.evalCtx, false)
        if (isPrimitive(value)) {
          resolved++
          return literalNode(value)
        }
      } catch {
        // decoder uses something we cannot model — leave it
      }
    }
    // Direct index access into the string array, e.g. _0xarr[0x3]
    if (
      n.type === 'MemberExpression' &&
      n.object.type === 'Identifier' &&
      arrayNames.has(n.object.name)
    ) {
      try {
        const value = evalNode(n, ctx.env, ctx.evalCtx, false)
        if (typeof value === 'string') {
          resolved++
          return literalNode(value)
        }
      } catch {
        // leave it
      }
    }
    return null
  })

  if (decoders.size === 0 && resolved === 0) return false
  if (resolved === 0) ctx.notes.push(`string-array-unpack: found ${arrays.size} array(s) but resolved 0 references`)
  return resolved > 0
}

function runDecoderChain(ctx: PassContext): boolean {
  let changed = false
  ctx.program = transform(ctx.program, (n) => {
    if (n.type !== 'CallExpression') return null
    const callee = n.callee
    const isBuiltinCall =
      (callee.type === 'Identifier' && callee.name in BUILTIN_FNS) ||
      (callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        Boolean(NAMESPACE_METHODS[callee.object.name]) &&
        (propName(callee) ?? '') in (NAMESPACE_METHODS[callee.object.name] ?? {}))
    if (!isBuiltinCall) return null
    try {
      const value = evalNode(n, ctx.env, ctx.evalCtx, false)
      if (isPrimitive(value) && value !== undefined) {
        changed = true
        return literalNode(value)
      }
    } catch {
      // leave it
    }
    return null
  })
  return changed
}

function runPackerUnpack(ctx: PassContext): boolean {
  let changed = false
  rewriteStatementLists(ctx.program, (list) => {
    const out: AstNode[] = []
    for (const stmt of list) {
      const unpacked = tryUnpackPacker(stmt, ctx)
      if (unpacked) {
        changed = true
        out.push(...unpacked)
      } else {
        out.push(stmt)
      }
    }
    return out
  })
  return changed
}

function runSimplify(ctx: PassContext): boolean {
  let changed = false
  rewriteStatementLists(ctx.program, (list) => {
    const out: AstNode[] = []
    for (const stmt of list) {
      if (stmt.type === 'ExpressionStatement' && stmt.expression?.type === 'SequenceExpression') {
        changed = true
        for (const expr of stmt.expression.expressions) {
          out.push({ type: 'ExpressionStatement', expression: expr, start: 0, end: 0 })
        }
      } else {
        out.push(stmt)
      }
    }
    return out
  })
  return changed
}

function runRename(ctx: PassContext): boolean {
  const decls = countDeclarations(ctx.program)
  const existing = collectIdentifierNames(ctx.program)
  const rename = new Map<string, string>()
  let counter = 0
  for (const [name, count] of decls) {
    if (count !== 1) continue
    const isMangled = /^_0x[0-9a-fA-F]+$/.test(name) || /^[A-Za-z]$/.test(name)
    if (!isMangled) continue
    let next = `v${++counter}`
    while (existing.has(next)) next = `v${++counter}`
    existing.add(next)
    rename.set(name, next)
  }
  if (rename.size === 0) return false

  walkWithParents(ctx.program, null, null, (node, parent, key) => {
    if (node.type !== 'Identifier') return
    if (!rename.has(node.name)) return
    if (isDeclarationIdentifier(parent, key)) {
      node.name = rename.get(node.name)!
      return
    }
    if (isNonReferenceIdentifier(parent, key)) return
    if (parent?.type === 'Property' && parent.shorthand) return
    node.name = rename.get(node.name)!
  })
  return true
}

function runDeadCode(ctx: PassContext): boolean {
  // Dynamic references via eval/Function make reachability undecidable; bail.
  let hasEval = false
  walk(ctx.program, (n) => {
    if (
      n.type === 'CallExpression' &&
      n.callee?.type === 'Identifier' &&
      (n.callee.name === 'eval' || n.callee.name === 'Function')
    ) {
      hasEval = true
    }
  })
  if (hasEval) return false

  const refs = countReferences(ctx.program)
  let changed = false

  const isUnreferenced = (id: AstNode): boolean =>
    id.type === 'Identifier' && (refs.get(id.name) ?? 0) === 0

  // At the top level of a classic script, `var` and function declarations
  // become properties of globalThis and may be referenced by inline handlers or
  // other scripts, so we never treat them as dead. Everything inside a
  // function/block is genuinely local and safe to prune when unreferenced.
  const prune = (list: AstNode[], topLevel: boolean): AstNode[] => {
    const out: AstNode[] = []
    for (const stmt of list) {
      if (stmt.type === 'FunctionDeclaration' && stmt.id && !topLevel && isUnreferenced(stmt.id)) {
        changed = true
        continue
      }
      if (stmt.type === 'VariableDeclaration') {
        const removable = !(topLevel && stmt.kind === 'var')
        if (removable) {
          const kept = stmt.declarations.filter((d: AstNode) => !isUnreferenced(d.id))
          if (kept.length !== stmt.declarations.length) {
            changed = true
            if (kept.length === 0) continue
            stmt.declarations = kept
          }
        }
      }
      out.push(stmt)
    }
    return out
  }

  const processNode = (node: AstNode): void => {
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      node.body = prune(node.body as AstNode[], node.type === 'Program')
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const value = node[key]
      if (isNode(value)) processNode(value)
      else if (Array.isArray(value)) for (const item of value) if (isNode(item)) processNode(item)
    }
  }
  processNode(ctx.program)
  return changed
}

// ---------------------------------------------------------------------------
// Family detection
// ---------------------------------------------------------------------------

function detectFamily(source: string, program: AstNode, pre: PreScan): DeobfuscateStaticFamily {
  // JSFuck / JJEncode / AAEncode: almost entirely punctuation.
  const stripped = source.replace(/\s+/g, '')
  if (stripped.length > 0) {
    const punctuation = (stripped.match(/[\[\]()!+]/g) ?? []).length
    if (punctuation / stripped.length > 0.8) {
      return { name: 'jsfuck', confidence: 0.7 }
    }
  }

  let hasPacker = false
  walk(program, (n) => {
    if (
      n.type === 'CallExpression' &&
      n.callee?.type === 'Identifier' &&
      n.callee.name === 'eval' &&
      n.arguments?.[0]?.type === 'CallExpression' &&
      (n.arguments[0].callee?.type === 'FunctionExpression' ||
        n.arguments[0].callee?.type === 'ArrowFunctionExpression')
    ) {
      hasPacker = true
    }
  })
  if (hasPacker) return { name: 'dean-edwards-packer', confidence: 0.9 }

  if (pre.stringArraySize >= 10 && pre.manglingRatio > 0.3) {
    return { name: 'obfuscator.io', confidence: 0.7 }
  }
  if (pre.manglingRatio > 0.5) {
    return { name: 'hex-identifier-mangling', confidence: 0.5 }
  }
  if (pre.manglingRatio > 0.25) {
    return { name: 'identifier-mangling', confidence: 0.4 }
  }
  return { name: 'unknown', confidence: 0.2 }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function truncateBytes(text: string, maxBytes: number, note: (n: string) => void): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  note(`output truncated to ${maxBytes} bytes`)
  return text.slice(0, lo)
}

function emptyMetrics(inputBytes: number): DeobfuscateStaticMetrics {
  return {
    inputBytes,
    outputBytes: 0,
    entropyBefore: 0,
    entropyAfter: 0,
    identifierManglingRatio: 0,
    evalCount: 0,
    stringArraySize: 0
  }
}

function deobfuscate(input: DeobfuscateStaticInput): DeobfuscateStaticOutput {
  const { source } = input
  const notes: string[] = []
  const inputBytes = Buffer.byteLength(source, 'utf8')

  let program: AstNode
  try {
    program = parseProgram(source)
  } catch (e) {
    notes.push(`parse failed: ${e instanceof Error ? e.message : String(e)}`)
    return {
      status: 'error',
      family: { name: 'unknown', confidence: 0 },
      transformed: '',
      truncated: false,
      metrics: emptyMetrics(inputBytes),
      passes: [],
      indicators: { urls: [], domains: [], stringLiterals: [] },
      notes
    }
  }

  const pre = preScan(program)
  const family = detectFamily(source, program, pre)
  const { scope: env, tainted } = buildEnv(program)
  const passCtx: PassContext = {
    program,
    env,
    tainted,
    evalCtx: { steps: 0, stepLimit: STEP_LIMIT },
    notes
  }

  const enabled = new Set<DeobfuscateTechnique>(input.techniques ?? DEOBFUSCATE_TECHNIQUES)
  const passes: DeobfuscateStaticPass[] = []

  const run = (name: DeobfuscateTechnique, fn: (c: PassContext) => boolean): void => {
    if (!enabled.has(name)) return
    let changed = false
    try {
      changed = fn(passCtx)
    } catch (e) {
      notes.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
    passes.push({ name, changed })
  }

  run('constant-fold', runConstantFold)
  run('string-array-unpack', runStringArrayUnpack)
  run('decoder-chain', runDecoderChain)
  run('eval-packer-unpack', runPackerUnpack)
  run('simplify', runSimplify)
  run('rename', runRename)
  run('dead-code', runDeadCode)

  let transformed: string
  try {
    transformed = generate(passCtx.program as any, { comments: false, indent: '  ' })
  } catch (e) {
    notes.push(`codegen failed: ${e instanceof Error ? e.message : String(e)}`)
    transformed = source
  }

  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const truncatedText = truncateBytes(transformed, maxBytes, (n) => notes.push(n))
  const truncated = truncatedText.length !== transformed.length

  const metrics: DeobfuscateStaticMetrics = {
    inputBytes,
    outputBytes: Buffer.byteLength(transformed, 'utf8'),
    entropyBefore: shannonEntropy(source),
    entropyAfter: shannonEntropy(transformed),
    identifierManglingRatio: pre.manglingRatio,
    evalCount: pre.evalCount,
    stringArraySize: pre.stringArraySize
  }

  return {
    status: truncated ? 'partial' : 'ok',
    family,
    transformed: truncatedText,
    truncated,
    metrics,
    passes,
    indicators: collectIndicators(passCtx.program),
    notes
  }
}

export const deobfuscateStaticTool: CapabilityTool<DeobfuscateStaticInput, DeobfuscateStaticOutput> = {
  name: 'deobfuscate_static',
  description:
    'Static JavaScript deobfuscator. Parses untrusted JS (never executes it) and rewrites constant folding, decoder chains, obfuscator.io string arrays and Dean Edwards packer output into readable source, with a structural report and extracted indicators. Pure string analysis.',
  riskTier: 'processing',
  inputSchema: obj(
    {
      source: str('The JavaScript source to deobfuscate.'),
      techniques: arrOf(
        enumOf(DEOBFUSCATE_TECHNIQUES, 'A deobfuscation pass.'),
        'Optional subset of passes to run (default: all).'
      ),
      maxOutputBytes: num('Cap on the returned transformed source in bytes (default 262144).')
    },
    ['source']
  ),
  outputSchema: obj(
    {
      status: enumOf(['ok', 'partial', 'error'], 'Overall deobfuscation status.'),
      family: obj(
        {
          name: str('Detected obfuscation family name.'),
          confidence: num('Confidence in the family classification (0–1).')
        },
        ['name', 'confidence']
      ),
      transformed: str('The deobfuscated source.'),
      truncated: bool('Whether the transformed source was byte-capped.'),
      metrics: objOf('Structural metrics of the before/after source.'),
      passes: arrOf(
        obj(
          {
            name: str('Pass name.'),
            changed: bool('Whether the pass changed the source.'),
            note: str('Optional pass note.')
          },
          ['name', 'changed']
        ),
        'Structured report of the passes applied.'
      ),
      indicators: obj(
        {
          urls: arrOf(str('A URL found in the source.'), 'URLs found in the source.'),
          domains: arrOf(str('A domain found in the source.'), 'Domains found in the source.'),
          stringLiterals: arrOf(str('A notable string literal.'), 'Notable string literals.')
        },
        ['urls', 'domains', 'stringLiterals']
      ),
      notes: arrOf(str('A non-fatal observation.'), 'Non-fatal observations.')
    },
    ['status', 'family', 'transformed', 'truncated', 'metrics', 'passes', 'indicators', 'notes']
  ),
  validateInput: validate,
  handler: deobfuscate
}
