// mine_params — ARCHITECTURE.MD §5.E.
//
// Pure-compute parameter-name generator. It GENERATES candidate parameter
// names as DATA ONLY from curated static wordlists plus variants derived
// from names the agent already observed. It never sends, fetches, reads, or
// writes anything — no network, filesystem, or process I/O. Deterministic
// given the same input (no randomness, no clock reads). The agent feeds the
// returned names into Dev 3's request tools separately.

import type { CapabilityTool, ValidationResult } from '../shared/tools'
import { arrOf, bool, enumOf, num, obj, objOf, str } from './schema'

// ---------------------------------------------------------------------------
// Inlined types (per §5.E: only generic helpers are imported from shared).
// ---------------------------------------------------------------------------

type MineParamsCategory =
  | 'common'
  | 'idor'
  | 'debug'
  | 'auth'
  | 'pagination'
  | 'redirect'

type MineParamsInput = {
  observed?: string[]
  categories?: MineParamsCategory[]
  includeCaseVariants?: boolean
}

type MineParamsOutput = {
  candidates: string[]
  byCategory: Record<string, string[]>
  count: number
}

// ---------------------------------------------------------------------------
// Bounds (input treated as hostile; output size capped).
// ---------------------------------------------------------------------------

const MAX_CANDIDATES = 5000
const MAX_OBSERVED = 500
const MAX_OBSERVED_LEN = 200

const ALL_CATEGORIES: readonly MineParamsCategory[] = [
  'common',
  'idor',
  'debug',
  'auth',
  'pagination',
  'redirect'
]

/** Curated static wordlist buckets — plain names, no secrets, no live data. */
const BUCKETS: Record<MineParamsCategory, readonly string[]> = {
  common: [
    'id',
    'page',
    'q',
    'search',
    'query',
    'name',
    'type',
    'sort',
    'order',
    'filter',
    'view',
    'lang',
    'format',
    'tab'
  ],
  idor: [
    'user_id',
    'account_id',
    'order_id',
    'uuid',
    'customer_id',
    'invoice_id',
    'doc_id',
    'file_id',
    'record_id',
    'object_id',
    'profile_id'
  ],
  debug: [
    'debug',
    'test',
    'admin',
    'verbose',
    'trace',
    'dev',
    'log',
    'mock',
    'sandbox',
    'stage',
    'env'
  ],
  auth: [
    'token',
    'api_key',
    'auth',
    'session',
    'access_token',
    'refresh_token',
    'jwt',
    'key',
    'secret',
    'password',
    'username',
    'otp'
  ],
  pagination: [
    'page',
    'limit',
    'offset',
    'per_page',
    'page_size',
    'cursor',
    'start',
    'count',
    'size'
  ],
  redirect: [
    'url',
    'next',
    'redirect',
    'return',
    'return_url',
    'callback',
    'dest',
    'destination',
    'continue',
    'goto',
    'target',
    'redirect_uri'
  ]
}

/** Leading-noun synonyms used to derive sibling guesses (e.g. userId -> account_id). */
const NOUN_SYNONYMS: Record<string, readonly string[]> = {
  user: ['account', 'customer', 'member'],
  account: ['user', 'customer'],
  customer: ['user', 'account'],
  order: ['invoice', 'transaction'],
  doc: ['file', 'record'],
  file: ['doc', 'record']
}

// ---------------------------------------------------------------------------
// Validation (hostile input: reject, never coerce).
// ---------------------------------------------------------------------------

function isCategory(v: unknown): v is MineParamsCategory {
  return typeof v === 'string' && (ALL_CATEGORIES as readonly string[]).includes(v)
}

function validate(raw: unknown): ValidationResult<MineParamsInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be an object'] }
  }
  const obj = raw as Record<string, unknown>
  const errors: string[] = []

  const value: MineParamsInput = {}

  if (obj.observed !== undefined) {
    if (!Array.isArray(obj.observed) || !obj.observed.every((x) => typeof x === 'string')) {
      errors.push('observed must be a string[]')
    } else if (obj.observed.length > MAX_OBSERVED) {
      errors.push(`observed must have <= ${MAX_OBSERVED} entries`)
    } else if (obj.observed.some((x) => (x as string).length > MAX_OBSERVED_LEN)) {
      errors.push(`observed entries must be <= ${MAX_OBSERVED_LEN} chars`)
    } else {
      value.observed = obj.observed as string[]
    }
  }

  if (obj.categories !== undefined) {
    if (!Array.isArray(obj.categories) || !obj.categories.every(isCategory)) {
      errors.push(`categories entries must be one of ${ALL_CATEGORIES.join(', ')}`)
    } else {
      value.categories = obj.categories as MineParamsCategory[]
    }
  }

  if (obj.includeCaseVariants !== undefined) {
    if (typeof obj.includeCaseVariants !== 'boolean') {
      errors.push('includeCaseVariants must be a boolean')
    } else {
      value.includeCaseVariants = obj.includeCaseVariants
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// Name tokenization + case-variant / sibling derivation.
// ---------------------------------------------------------------------------

/** Split a param name into lowercase words across snake/camel/Pascal/kebab boundaries. */
function splitWords(name: string): string[] {
  return name
    .replace(/[_\-\s]+/g, ' ')
    // camelCase / PascalCase boundaries, and ACRONYMFollowed boundaries.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

function toSnake(words: string[]): string {
  return words.join('_')
}

function toCamel(words: string[]): string {
  return words
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('')
}

function toPascal(words: string[]): string {
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

/** snake_case / camelCase / PascalCase forms of one name. */
function caseVariants(name: string): string[] {
  const words = splitWords(name)
  if (words.length === 0) return []
  return [toSnake(words), toCamel(words), toPascal(words)]
}

/** Siblings/abbreviations derived from one observed name. */
function derivedFromObserved(name: string): string[] {
  const out = new Set<string>()
  const words = splitWords(name)
  if (words.length === 0) return []

  // Case variants always accompany an observed name — that's the point of it.
  for (const v of caseVariants(name)) out.add(v)

  const lastIsId = words[words.length - 1] === 'id'
  const first = words[0]

  // id abbreviation: userId -> uid, orderId -> oid.
  if (lastIsId && words.length >= 2) {
    out.add(first.charAt(0) + 'id')
  }

  // Noun synonyms: userId -> account_id, customer_id, member_id (+ case forms).
  const synonyms = NOUN_SYNONYMS[first]
  if (synonyms) {
    for (const syn of synonyms) {
      const sibling = [syn, ...words.slice(1)]
      out.add(toSnake(sibling))
      out.add(toCamel(sibling))
      out.add(toPascal(sibling))
    }
  }

  return [...out]
}

// ---------------------------------------------------------------------------
// Generator.
// ---------------------------------------------------------------------------

function generate(input: MineParamsInput): MineParamsOutput {
  const categories =
    input.categories && input.categories.length > 0 ? input.categories : [...ALL_CATEGORIES]
  const includeCaseVariants = input.includeCaseVariants === true

  // Build a per-category set first, then derive the union + byCategory from it.
  const perCategory = new Map<string, Set<string>>()

  const addTo = (category: string, name: string) => {
    let set = perCategory.get(category)
    if (!set) {
      set = new Set<string>()
      perCategory.set(category, set)
    }
    set.add(name)
    if (includeCaseVariants) {
      for (const v of caseVariants(name)) set.add(v)
    }
  }

  // Dedupe categories while preserving a stable iteration order.
  const seenCat = new Set<string>()
  for (const category of categories) {
    if (seenCat.has(category)) continue
    seenCat.add(category)
    for (const name of BUCKETS[category]) {
      addTo(category, name)
    }
  }

  // Observed-derived candidates live under their own 'observed' category.
  if (input.observed) {
    for (const name of input.observed) {
      for (const derived of derivedFromObserved(name)) {
        addTo('observed', derived)
      }
    }
  }

  // Union, de-duped and sorted, then capped to bound output size.
  const union = new Set<string>()
  for (const set of perCategory.values()) {
    for (const name of set) union.add(name)
  }
  const candidates = [...union].sort().slice(0, MAX_CANDIDATES)
  const capped = new Set(candidates)

  // byCategory reflects only the names that survived the cap, sorted.
  const byCategory: Record<string, string[]> = {}
  for (const [category, set] of perCategory) {
    const members = [...set].filter((n) => capped.has(n)).sort()
    if (members.length > 0) byCategory[category] = members
  }

  return { candidates, byCategory, count: candidates.length }
}

export const mineParamsTool: CapabilityTool<MineParamsInput, MineParamsOutput> = {
  name: 'mine_params',
  description:
    'Generates candidate HTTP parameter names from curated static wordlists and variants derived from observed names. Pure compute; never sends anything.',
  riskTier: 'read-only',
  inputSchema: obj({
    observed: arrOf(str('A parameter name already observed.'), 'Observed parameter names to derive variants from.'),
    categories: arrOf(enumOf(ALL_CATEGORIES, 'A wordlist category.'), 'Wordlist categories to include (default: all).'),
    includeCaseVariants: bool('Also emit snake/camel/Pascal case variants of each name.')
  }),
  outputSchema: obj(
    {
      candidates: arrOf(str('A candidate parameter name.'), 'De-duplicated, sorted candidate names.'),
      byCategory: objOf('Category → candidate names.', {
        additionalProperties: { type: 'array', items: { type: 'string' } }
      }),
      count: num('Number of candidates.')
    },
    ['candidates', 'byCategory', 'count']
  ),
  validateInput: validate,
  handler: generate
}
