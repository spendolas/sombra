/**
 * Which node mini-previews are currently on screen.
 *
 * `NodePreview` reports its canvas through an IntersectionObserver; the preview
 * scheduler skips compiling/rendering any node that is not in this set, so a
 * large graph only pays for the thumbnails the user can actually see. A hidden
 * node keeps its last bitmap and stays stale, so it refreshes as soon as it
 * scrolls back into view.
 */
const visible = new Set<string>()

export function setPreviewVisible(nodeId: string, isVisible: boolean): void {
  if (isVisible) visible.add(nodeId)
  else visible.delete(nodeId)
}

export function isPreviewVisible(nodeId: string): boolean {
  return visible.has(nodeId)
}

export function visiblePreviewCount(): number {
  return visible.size
}
