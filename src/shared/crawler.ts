// Deterministic, non-AI link extractor for the crawler/spider (ARCHITECTURE.MD §11.4).
//
// Pure compute: parses one page's HTML string and returns normalized, de-duped,
// in-scope candidate URLs to queue next. It NEVER fetches — all egress stays with
// Dev 3's scope-checked navigate/replay. Dependency-free (no DOMParser) so it runs
// identically in node (tests) and the renderer. Deterministic: same HTML + base in,
// same sorted list out.

export type CrawlCandidate = {
  url: string
  /** Where the link came from: anchor href, form action, or resource src. */
  source: 'anchor' | 'form' | 'resource'
}

// --- Driver contract (main process crawler + renderer panel) ------------------

/** Request to start a crawl. Egress still goes through the scope-/rate-gated replayer. */
export type CrawlStartInput = {
  url: string
  /** Max link depth from the start URL. Clamped 0..10 in the driver. Default 2. */
  maxDepth?: number
  /** Hard cap on pages fetched. Clamped 1..500 in the driver. Default 50. */
  maxPages?: number
  /** Also follow form actions and resource src, not just anchors. Default false. */
  includeResources?: boolean
}

/** One fetched page in a crawl run. `status` is null when the fetch never completed. */
export type CrawlPageResult = {
  url: string
  depth: number
  status: number | null
  /** Set when the replayer rejected or the fetch failed (denied/rate-limited/network/non-html). */
  reason?: string
}

/** Why a crawl stopped. */
export type CrawlStopReason = 'done' | 'max-pages' | 'stopped' | 'error'

/** Live crawl state, pushed to the renderer over `crawl:state`. */
export type CrawlState = {
  running: boolean
  startUrl: string | null
  /** Pages fetched (whether or not they yielded links). */
  visited: number
  /** URLs still waiting in the frontier. */
  queued: number
  pages: CrawlPageResult[]
  stoppedReason?: CrawlStopReason
}

export type CrawlExtractOptions = {
  /** Also pull form actions and script/img/iframe/source src, not just <a href>. Default false. */
  includeResources?: boolean
}

// Attribute extractors — case-insensitive, matching double-, single-, or unquoted values.
// Groups 2/3/4 hold the value for the three quoting styles.
const HREF_RE = /<a\b[^>]*?\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const ACTION_RE = /<form\b[^>]*?\saction\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const SRC_RE = /<(?:script|img|iframe|source)\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

function* matchValues(re: RegExp, html: string): Generator<string> {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const raw = m[2] ?? m[3] ?? m[4] ?? ''
    if (raw) yield raw
  }
}

/** Resolves a raw value against base: absolute http(s) URL with the fragment stripped, or null. */
function normalize(raw: string, base: string): string | null {
  const value = raw.trim()
  if (!value) return null
  // Non-navigational schemes and pure fragments never belong in the frontier.
  if (/^(javascript:|mailto:|tel:|data:|blob:|#)/i.test(value)) return null
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  return url.toString()
}

/**
 * Extracts candidate URLs from one page's HTML, resolved absolute against baseUrl,
 * de-duped (first source wins) and sorted. By default only <a href>; set
 * includeResources to also pull form actions and script/img/iframe/source src.
 */
export function extractLinks(
  html: string,
  baseUrl: string,
  options: CrawlExtractOptions = {}
): CrawlCandidate[] {
  const seen = new Map<string, CrawlCandidate>()
  const add = (raw: string, source: CrawlCandidate['source']): void => {
    const url = normalize(raw, baseUrl)
    if (url && !seen.has(url)) seen.set(url, { url, source })
  }
  for (const v of matchValues(HREF_RE, html)) add(v, 'anchor')
  if (options.includeResources) {
    for (const v of matchValues(ACTION_RE, html)) add(v, 'form')
    for (const v of matchValues(SRC_RE, html)) add(v, 'resource')
  }
  return [...seen.values()].sort((a, b) => a.url.localeCompare(b.url))
}

export type NextTargetsOptions = CrawlExtractOptions & {
  /** URLs already visited or queued — excluded from the result. */
  seen?: Iterable<string>
  /** Cap on returned candidates (bounds the frontier). Default 500. */
  limit?: number
}

/**
 * The crawler's "what to queue next" brain: extract links, keep only those the
 * scope checker allows, drop already-seen URLs, cap the count. Pure + deterministic.
 * `isAllowed` is the §6.5 ScopeChecker.isAllowed shape, so scope stays the single
 * source of truth — this decides only which in-scope URLs to enqueue, never fetches.
 */
export function nextCrawlTargets(
  html: string,
  baseUrl: string,
  isAllowed: (url: string) => boolean,
  options: NextTargetsOptions = {}
): CrawlCandidate[] {
  const { seen, limit = 500, ...extract } = options
  const skip = new Set(seen ?? [])
  const out: CrawlCandidate[] = []
  for (const candidate of extractLinks(html, baseUrl, extract)) {
    if (skip.has(candidate.url)) continue
    if (!isAllowed(candidate.url)) continue
    out.push(candidate)
    if (out.length >= limit) break
  }
  return out
}
