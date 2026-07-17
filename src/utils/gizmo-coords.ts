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

/**
 * Convert a UV point param (u, v) — normalized 0..1 across the canvas, matching
 * the shader's `v_uv`: origin BOTTOM-left, Y-UP (v=0 at the canvas bottom, v=1
 * at the top). Screen Y is down, so v is flipped here. Unlike px space, UV
 * renormalizes with `rect`, so a fixed (u, v) tracks its canvas landmark (e.g.
 * u=1 stays on the right edge) across resizes.
 */
export function uvToScreen(u: number, v: number, rect: Rect): { x: number; y: number } {
  return {
    x: rect.left + u * rect.width,
    y: rect.top + (1 - v) * rect.height,
  }
}

/** Inverse of `uvToScreen`: screen (sx, sy) over `rect` back to UV (u, v),
 *  Y-up (v=0 at bottom) to match the shader's `v_uv`. */
export function screenToUv(sx: number, sy: number, rect: Rect): { u: number; v: number } {
  return {
    u: rect.width > 0 ? (sx - rect.left) / rect.width : 0,
    v: rect.height > 0 ? 1 - (sy - rect.top) / rect.height : 0,
  }
}
