/**
 * Node mini-preview raster size.
 *
 * A preview is shown at the node's width (CSS px), so it is rasterised at that
 * width x the screen's device-pixel ratio instead of a fixed 160 px that the
 * browser then stretched. The preview fills the node width
 * (`nodePreview` = `w-full`), so the raster is ~1:1 with device pixels on a 1x
 * screen and ~0.9:1 (capped) on a 2x screen. The edge is quantised to a multiple of 32 and capped:
 * a bigger raster costs quadratically in fill + readback for every visible
 * node, and past ~1.5x the displayed size the extra pixels are barely visible.
 *
 * Composition is unchanged by the size: the shader sees a notional 80 CSS px
 * thumbnail at `dpr = size / PREVIEW_CSS_SIZE`, so `u_frame_scale`/`u_dpr`
 * scale with the raster and scene-locked features keep their relative size
 * (see `u_frame_scale` in CLAUDE.md).
 */

/** Notional thumbnail edge the shader composes against (CSS px). */
export const PREVIEW_CSS_SIZE = 80

/** Displayed edge of a preview — the node's min width (`--sz-node-min-w`). */
export const PREVIEW_DISPLAY_CSS = 212

const MIN_SIZE = 128
const MAX_SIZE = 384
const STEP = 32

/** Raster edge (device px) for a given device-pixel ratio. */
export function previewSizeFor(dpr: number): number {
  const d = Math.min(Math.max(dpr, 1), 2)
  const raw = Math.round((PREVIEW_DISPLAY_CSS * d) / STEP) * STEP
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, raw))
}

/** Raster edge for the current screen; safe outside the main thread. */
export function getPreviewSize(): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 2
  return previewSizeFor(dpr)
}

/** `u_dpr` / `u_frame_scale` for a preview rasterised at `size`. */
export function previewDprFor(size: number): number {
  return size / PREVIEW_CSS_SIZE
}
