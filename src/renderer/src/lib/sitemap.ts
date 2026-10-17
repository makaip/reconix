import type { CapturedRequest } from '../../../shared/tabs'

/** A flattened sitemap row. "folder" = host or path prefix with children; "page" = leaf endpoint. */
export type SitemapNode = {
  id: string
  label: string
  /** nest level */
  depth: number
  kind: 'folder' | 'page'
}

type TreeNode = { seg: string; children: Map<string, TreeNode>; isEndpoint: boolean }

const newNode = (seg: string): TreeNode => ({ seg, children: new Map(), isEndpoint: false })

/**
 * Builds a host → path-segment sitemap PASSIVELY from already-captured requests
 * (ARCHITECTURE.MD §11.1 — no new fetches). Deterministic: hosts and segments are
 * sorted alphabetically so the tree is stable as new requests arrive.
 */
export function buildSitemap(requests: CapturedRequest[]): SitemapNode[] {
  const hosts = new Map<string, TreeNode>()

  for (const request of requests) {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      continue
    }
    const host = url.hostname
    if (!host) continue
    const root = hosts.get(host) ?? newNode(host)
    hosts.set(host, root)

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length === 0) {
      root.isEndpoint = true
      continue
    }
    let cursor = root
    segments.forEach((segment, i) => {
      let child = cursor.children.get(segment)
      if (!child) {
        child = newNode(segment)
        cursor.children.set(segment, child)
      }
      if (i === segments.length - 1) child.isEndpoint = true
      cursor = child
    })
  }

  const out: SitemapNode[] = []
  const walk = (node: TreeNode, depth: number, idPrefix: string, isHost: boolean): void => {
    const id = isHost ? node.seg : `${idPrefix}/${node.seg}`
    out.push({
      id,
      label: isHost ? node.seg : `/${node.seg}`,
      depth,
      kind: node.children.size > 0 ? 'folder' : 'page'
    })
    for (const child of [...node.children.values()].sort((a, b) => a.seg.localeCompare(b.seg))) {
      walk(child, depth + 1, id, false)
    }
  }
  for (const host of [...hosts.values()].sort((a, b) => a.seg.localeCompare(b.seg))) {
    walk(host, 0, '', true)
  }
  return out
}
