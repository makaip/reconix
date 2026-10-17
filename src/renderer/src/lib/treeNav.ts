/** Minimal shape for keyboard navigation over a flattened, visible tree. */
type FlatNode = { depth: number; kind: 'folder' | 'page' }

/** Rows per PageUp/PageDown step. */
const PAGE = 10

/**
 * Where an up/down-style key moves the cursor in a flattened tree, or null if the key
 * isn't a vertical move. `index` is -1 when nothing is focused yet.
 */
export function verticalTarget(key: string, index: number, count: number): number | null {
  if (count === 0) return null
  const last = count - 1
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : Math.min(index + 1, last)
    case 'ArrowUp':
      return index < 0 ? last : Math.max(index - 1, 0)
    case 'PageDown':
      return Math.min(Math.max(index, 0) + PAGE, last)
    case 'PageUp':
      return Math.max(index - PAGE, 0)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/** Index of the nearest row above `index` with a smaller depth (its parent), or -1. */
export function parentIndex(nodes: readonly FlatNode[], index: number): number {
  const depth = nodes[index]?.depth ?? 0
  for (let i = index - 1; i >= 0; i--) if (nodes[i].depth < depth) return i
  return -1
}

/** Index of the first visible child of the folder at `index`, or -1 (collapsed / no children). */
export function firstChildIndex(nodes: readonly FlatNode[], index: number): number {
  const next = nodes[index + 1]
  return next && next.depth > nodes[index].depth ? index + 1 : -1
}
