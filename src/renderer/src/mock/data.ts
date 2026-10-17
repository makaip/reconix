// mock fake data for dev mode until i get real website working

export type SitemapNode = {
  id: string
  label: string
  /** nest level */
  depth: number
  /** "folder" nodes are hosts or path prefixes, "page" nodes are leaf endpoints */
  kind: 'folder' | 'page'
}

export type Severity = 'medium' | 'low' | 'info'

export type Finding = {
  id: string
  severity: Severity
  title: string
}

export const sitemap: SitemapNode[] = [
  { id: 'host', label: 'app.example.test', depth: 0, kind: 'folder' },
  { id: 'login', label: '/login', depth: 1, kind: 'page' },
  { id: 'dashboard', label: '/dashboard', depth: 1, kind: 'page' },
  { id: 'api', label: '/api/v1', depth: 1, kind: 'folder' },
  { id: 'users', label: '/users', depth: 2, kind: 'page' },
  { id: 'orders', label: '/orders', depth: 2, kind: 'page' },
  { id: 'static', label: '/static', depth: 1, kind: 'folder' }
]

// Seeded findings removed: the panel must not assert vulnerabilities the agent
// hasn't actually confirmed, or it taints the assessment (and any human/agent
// reading the panel). Real findings arrive via record_finding through the MCP
// pipeline. Empty until then.
export const findings: Finding[] = []

export const engagement = 'Q4 web app'

// placeholders until proxy and scope rules exist
export const proxy = { label: ':8080', address: '127.0.0.1:8080' }
export const scope = { hosts: ['app.example.test'], summary: '1 host · 4 rules' }
