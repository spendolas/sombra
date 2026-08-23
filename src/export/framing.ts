/**
 * Size + Framing → export-frame parameters
 * Pure functions that turn the export modal's Size + Framing controls
 * into the values the renderer needs (FramingChoice) and user-facing
 * descriptions (describeResult).
 */

export type SizeSource =
  | { kind: 'match' }
  | { kind: 'mul'; factor: 2 | 4 }
  | { kind: 'preset'; w: number; h: number }
  | { kind: 'custom'; w: number; h: number }

export type FramingMode = 'reveal' | 'fill' | 'fit'

export interface FramingChoice {
  /** Framing/zoom scale → `u_frame_scale`. Drives `auto_uv` composition. */
  frameScale: number
  /** Device density → `u_dpr`. 1:1 export today; the supersample hook. */
  dpr: number
  anchor: [number, number]
}

export interface ViewInfo {
  cssW: number
  cssH: number
  deviceDpr: number
}

/**
 * Compute target export size from the source specification.
 * - match: the view's LOGICAL (CSS) size — exactly what the modal shows as
 *   "current view", so Match is a true 1:1. (On a retina display, 2× yields the
 *   device-pixel resolution — the familiar designer 1×/2× model.)
 * - mul: view logical size × factor (2×/4×)
 * - preset/custom: literal dimensions
 *
 * NOTE: deliberately NOT × deviceDpr. Multiplying made Match secretly 2× on
 * retina — mislabeled 1:1 and, with Reveal, revealed 2× more scene.
 */
export function targetSize(src: SizeSource, view: ViewInfo): { width: number; height: number } {
  switch (src.kind) {
    case 'match':
      return { width: view.cssW, height: view.cssH }
    case 'mul':
      return { width: view.cssW * src.factor, height: view.cssH * src.factor }
    case 'preset':
      return { width: src.w, height: src.h }
    case 'custom':
      return { width: src.w, height: src.h }
  }
}

/**
 * Compute framing parameters for the renderer.
 *
 * Preserve the view's framing except for Reveal. Framing (zoom/composition) and
 * device density are now two INDEPENDENT axes:
 * - `frameScale` → `u_frame_scale`: drives `auto_uv` composition (blur reach,
 *   anchor pinning, per-pass sizing). Reveal=1 (logical scale, anchor-relative
 *   crop/reveal); Fill/Fit scale so the view covers/fits the target aspect.
 * - `dpr` → `u_dpr`: pure device density. Held at 1 for a 1:1 export; a future
 *   supersample pass raises it WITHOUT moving the framing.
 *
 * The split resolves the old limitation where the single overloaded `u_dpr`
 * conflated composition and density. Blur reach (and every scene-locked feature)
 * now follows `u_frame_scale`: its reach in REFERENCE units is invariant across
 * framing modes and sizes, because the `u_frame_scale` factor in the sigma
 * cancels the one in `auto_uv`'s denominator — Reveal (frameScale=1) and live
 * (frameScale=deviceDpr) cover the same fraction of the composition.
 *
 * `u_dpr` is currently a reserved density knob with NO node consumer (export
 * holds it at 1; live sets it == frameScale == deviceDpr, so blur is unchanged
 * there). A follow-up may wire supersampled-AA smoothness onto `u_dpr` — more
 * samples across the SAME reach — behind a supersample UI. Deferred as YAGNI:
 * no product path emits dpr≠frameScale today. See the plan's Task 8 ruling.
 */
export function computeFraming(
  mode: FramingMode,
  view: ViewInfo,
  width: number,
  height: number,
): FramingChoice {
  if (mode === 'reveal') {
    return { frameScale: 1, dpr: 1, anchor: [0.5, 0.5] }
  }

  // Compute the composition scale factor. The view (editor's current view) is scaled
  // so it either covers or contains the target frame while maintaining aspect ratio.
  // Fill: scale to cover target → frameScale = max scale factor
  // Fit: scale to contain target → frameScale = min scale factor
  const scaleX = width / view.cssW
  const scaleY = height / view.cssH

  const frameScale = mode === 'fill' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY)

  return { frameScale, dpr: 1, anchor: [0.5, 0.5] }
}

/**
 * Describe the framing result for the user.
 * Returns text and a flag indicating whether the framing control should be hidden
 * (when target size == view size AND same aspect ratio).
 *
 * Card bodies are kept short (≤ ~40 chars) and balanced across the three modes.
 */
export function describeResult(
  src: SizeSource,
  mode: FramingMode,
  view: ViewInfo,
): { text: string; framingHidden: boolean } {
  const { width: targetW, height: targetH } = targetSize(src, view)

  // Compare against the view's LOGICAL size (Match == this, so it reads 1:1).
  const viewW = view.cssW
  const viewH = view.cssH

  // Compare the displayed (rounded) sizes: the view's CSS size is fractional,
  // so an exact-integer target (e.g. a Custom size typed to match the shown
  // "1364 × 756") would otherwise read as different and needlessly show framing.
  const sizeDiff = Math.round(targetW) !== Math.round(viewW) || Math.round(targetH) !== Math.round(viewH)
  const targetAR = targetW / targetH
  const viewAR = viewW / viewH
  const aspDiff = Math.abs(targetAR - viewAR) > 0.01

  // Hidden case: no size difference and no aspect ratio difference
  if (!sizeDiff && !aspDiff) {
    return { text: 'Exporting your current view exactly, 1:1.', framingHidden: true }
  }

  const bigger = targetW * targetH >= viewW * viewH

  let text: string

  if (mode === 'reveal') {
    if (aspDiff) {
      text = `Keeps scale; reveals the ${targetAR > viewAR ? 'wider' : 'taller'} axis.`
    } else if (bigger) {
      text = `Reveals more scene around the anchor.`
    } else {
      text = `Crops in tighter around the anchor.`
    }
  } else if (mode === 'fill') {
    if (aspDiff) {
      text = `Scaled to cover; ${targetAR > viewAR ? 'top & bottom' : 'sides'} cropped.`
    } else {
      text = bigger ? `Same composition, supersampled.` : `Same composition, downscaled.`
    }
  } else {
    // fit
    if (aspDiff) {
      text = `Whole view kept; ${targetAR > viewAR ? 'sides' : 'top & bottom'} filled.`
    } else {
      text = bigger ? `Same composition, supersampled.` : `Same composition, downscaled.`
    }
  }

  return { text, framingHidden: false }
}
