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

export type CopilotMessage =
  | { id: string; role: 'user'; context: string[]; text: string }
  | {
      id: string
      role: 'assistant'
      used: string
      text: string
      mapping?: { field: string; column: string }[]
      footnote?: string
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

export const findings: Finding[] = [
  { id: 'f1', severity: 'medium', title: 'Session cookie missing Secure flag' },
  { id: 'f2', severity: 'low', title: 'No Content-Security-Policy header' },
  { id: 'f3', severity: 'info', title: 'Verbose error page on /api/v1' }
]

export const engagement = 'Q4 web app'

export const messages: CopilotMessage[] = [
  {
    id: 'm1',
    role: 'user',
    context: ['<table.orders-table>'],
    text: 'Which columns does this table render, and which request fills it?'
  },
  {
    id: 'm2',
    role: 'assistant',
    used: 'used 1 DOM node, 1 captured request',
    text: "Rows come from GET /api/v1/orders?page=2. The table's data-endpoint attribute matches that request. Response fields map to columns:",
    mapping: [
      { field: 'id', column: 'Order' },
      { field: 'customer.email', column: 'Customer' },
      { field: 'total', column: 'Total' },
      { field: 'status', column: 'Status' }
    ],
    footnote: 'Paging is server-side. page is the only query parameter.'
  }
]

export const composerContext = ['current tab', '3 requests', 'scope']
