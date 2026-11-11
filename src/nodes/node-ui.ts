/**
 * Editor view state stored on a node (`NodeData.ui`) — today, which collapsible
 * sections of its body the user left open or closed.
 *
 * Owner decision: a collapse is deliberate and must stay as the user left it,
 * across reloads (localStorage) and `.sombra` files. It is view state, not
 * shader content, so it lives outside every compile key and outside undo
 * history (see graphStore.setSectionCollapsed and carryUiState).
 *
 * Only values that differ from a section's default are stored, so a graph
 * nobody toggled serialises exactly as it did before this field existed.
 */
import type { Node } from '@xyflow/react'
import type { NodeData } from './types'

/** The framework SRT section every spatial node carries. */
export const TRANSFORM_SECTION = 'transform'

/** Default collapsed state per section id. Unknown sections default to open. */
const SECTION_DEFAULT_COLLAPSED: Record<string, boolean> = {
  // Collapsed by default since the on-preview gizmo became the primary way to
  // place a node — the in-node sliders are the fallback.
  [TRANSFORM_SECTION]: true,
}

export function sectionDefaultCollapsed(section: string): boolean {
  return SECTION_DEFAULT_COLLAPSED[section] ?? false
}

/** Is `section` collapsed on this node? Absent → the section's default. */
export function isSectionCollapsed(data: Pick<NodeData, 'ui'>, section: string): boolean {
  const stored = data.ui?.collapsed?.[section]
  return typeof stored === 'boolean' ? stored : sectionDefaultCollapsed(section)
}

/**
 * `data` with `section` set to `collapsed`, or the SAME object when nothing
 * changes. A value equal to the default is removed rather than stored, and an
 * empty `ui` is dropped, so toggling back leaves no trace.
 */
export function withSectionCollapsed<T extends NodeData>(data: T, section: string, collapsed: boolean): T {
  const current = data.ui?.collapsed ?? {}
  // What should be stored: nothing when it equals the default.
  const want = collapsed === sectionDefaultCollapsed(section) ? undefined : collapsed
  if (current[section] === want && (want !== undefined || !(section in current))) return data
  const nextCollapsed: Record<string, boolean> = { ...current }
  if (want === undefined) delete nextCollapsed[section]
  else nextCollapsed[section] = want
  const { ui: _old, ...rest } = data
  const restUi = { ...(data.ui ?? {}) }
  delete restUi.collapsed
  const ui = Object.keys(nextCollapsed).length > 0 ? { ...restUi, collapsed: nextCollapsed } : restUi
  return (Object.keys(ui).length > 0 ? { ...rest, ui } : rest) as T
}

/**
 * Undo/redo restore a snapshot of the nodes; the view state in that snapshot is
 * whatever it was when the snapshot was taken. A section toggle is not an edit,
 * so it must survive an undo of an unrelated edit: copy each live node's `ui`
 * onto its restored counterpart. A node that no longer exists (an undone
 * delete) keeps the `ui` it was deleted with.
 */
export function carryUiState(restored: Node<NodeData>[], current: Node<NodeData>[]): Node<NodeData>[] {
  const live = new Map(current.map((n) => [n.id, n.data]))
  let changed = false
  const out = restored.map((n) => {
    const now = live.get(n.id)
    if (!now || now.ui === n.data.ui) return n
    changed = true
    const { ui: _old, ...rest } = n.data
    return { ...n, data: (now.ui === undefined ? rest : { ...rest, ui: now.ui }) as NodeData }
  })
  return changed ? out : restored
}
