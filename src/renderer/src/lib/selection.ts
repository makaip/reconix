/** Modifier state from a click/keydown, as far as multi-selection cares. */
export type SelectMods = { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }

/** The outcome of a selection gesture: the new set, and the anchor future shift-ranges extend from. */
export type Selection<T> = { set: Set<T>; anchor: T }

/**
 * Computes the next multi-selection from a click on `id`, given the current `set`/`anchor`
 * and the visible item order `ids` (needed for shift-range).
 *
 * - plain click: select only `id`
 * - cmd/ctrl click: toggle `id`
 * - shift click: select the contiguous range from the anchor to `id`
 */
export function nextSelection<T>(
  set: Set<T>,
  anchor: T | null,
  id: T,
  ids: readonly T[],
  mods: SelectMods
): Selection<T> {
  if (mods.shiftKey && anchor !== null) {
    const from = ids.indexOf(anchor)
    const to = ids.indexOf(id)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from]
      return { set: new Set(ids.slice(lo, hi + 1)), anchor }
    }
  }
  if (mods.metaKey || mods.ctrlKey) {
    const out = new Set(set)
    if (out.has(id)) out.delete(id)
    else out.add(id)
    return { set: out, anchor: id }
  }
  return { set: new Set([id]), anchor: id }
}
