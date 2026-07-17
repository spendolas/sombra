/**
 * Pure px↔screen coordinate mapping for the preview gizmo overlay.
 *
 * Point params (see `GizmoPoint` in `src/nodes/types.ts`) store CSS px
 * relative to a gizmo's anchor — the same space as the SRT translate params
 * (`srt_translateX`/`srt_translateY`). The overlay (a future task) uses these
 * functions to convert between that px space and on-screen coordinates over
 * the preview `<canvas>` so handles can be drawn and dragged.
 *
 * No DOM/React imports here — callers pass a plain rect, not a live DOMRect,
 * so this module stays testable and framework-agnostic.
 */

/** Minimal rect shape — duck-types DOMRect without requiring one. */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Convert a point param (px, py) — CSS px relative to the anchor — to screen
 * coordinates over `rect`.
 *
 * The anchor's own screen position is `(rect.left + anchor[0]*rect.width,
 * rect.top + anchor[1]*rect.height)`. Y is up (px grows away from the anchor
 * upward on screen), matching the shader translate's `-tY` convention.
 *
 * NOTE: the Y sign here is provisional — Task 3 calibrates it live against
 * the actual shader translate and may flip it. Keep `screenToPointPx` as its
 * exact inverse if that happens.
 */
export function pointPxToScreen(
  px: number,
  py: number,
  rect: Rect,
  anchor: [number, number],
): { x: number; y: number } {
  const anchorScreenX = rect.left + anchor[0] * rect.width
  const anchorScreenY = rect.top + anchor[1] * rect.height
  return {
    x: anchorScreenX + px,
    y: anchorScreenY - py,
  }
}

/**
 * Inverse of `pointPxToScreen`: convert screen coordinates (sx, sy) over
 * `rect` back to a point param (px, py) relative to the anchor.
 */
export function screenToPointPx(
  sx: number,
  sy: number,
  rect: Rect,
  anchor: [number, number],
): { x: number; y: number } {
  const anchorScreenX = rect.left + anchor[0] * rect.width
  const anchorScreenY = rect.top + anchor[1] * rect.height
  return {
    x: sx - anchorScreenX,
    y: anchorScreenY - sy,
  }
}
