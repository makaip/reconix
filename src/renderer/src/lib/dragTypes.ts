import type { CapturedRequest } from '../../../shared/tabs'

/** dataTransfer type used when dragging one or more DOM nodes from DevTools to Copilot. */
export const NODE_DRAG_TYPE = 'application/x-reconix-node'

/** dataTransfer type used when dragging source/sitemap files to Copilot. */
export const RESOURCE_DRAG_TYPE = 'application/x-reconix-resource'

/** dataTransfer type used when dragging captured network requests to Copilot. */
export const REQUEST_DRAG_TYPE = 'application/x-reconix-request'

/** dataTransfer type used when dragging a tab to reorder the tab strip. */
export const TAB_DRAG_TYPE = 'application/x-reconix-tab'

/** A DOM node payload carried on a drag (one entry per selected node). */
export type NodeDragItem = { nodeId: number; label: string; selector: string }

/** A file payload carried on a drag (source resource or sitemap endpoint). */
export type ResourceDragItem = { url: string; label: string; frameId?: string }

/** A captured request payload carried on a drag: a snapshot of the request plus its chip label. */
export type RequestDragItem = CapturedRequest & { label: string }

/** Reads a JSON array previously written with `event.dataTransfer.setData(type, …)`. */
export function readDragItems<T>(data: string): T[] {
  try {
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}
