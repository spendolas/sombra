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
  uDpr: number
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
 * Preserve the view's framing except for Reveal:
 * - Reveal: uDpr=1 makes the target pixel scale = logical scale (anchor-relative crop/reveal)
 * - Fill/Fit: uDpr scales so the view fits/covers the target aspect, preserving blur's visible reach
 *
 * Known limitation: For Reveal, uDpr=1 makes blur reach grow because u_dpr also scales blur radius.
 * The clean fix (separate u_frame_scale uniform) is parked for follow-up.
 */
export function computeFraming(
  mode: FramingMode,
  view: ViewInfo,
  width: number,
  height: number,
): FramingChoice {
  if (mode === 'reveal') {
    return { uDpr: 1, anchor: [0.5, 0.5] }
  }

  // Compute the composition scale factor. The view (editor's current view) is scaled
  // so it either covers or contains the target frame while maintaining aspect ratio.
  // Fill: scale to cover target → uDpr = max scale factor
  // Fit: scale to contain target → uDpr = min scale factor
  const scaleX = width / view.cssW
  const scaleY = height / view.cssH

  const uDpr = mode === 'fill' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY)

  return { uDpr, anchor: [0.5, 0.5] }
}

// Helper: compute gcd for aspect ratio simplification
function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

// Helper: format aspect ratio. Clean ratios read as "16:9"; odd view sizes
// reduce to ugly numbers (e.g. 124:53) — show a decimal "2.34:1" instead.
function aspectRatio(w: number, h: number): string {
  const g = gcd(Math.round(w), Math.round(h)) || 1
  const rw = Math.round(w / g)
  const rh = Math.round(h / g)
  if (rw > 21 || rh > 21) return `${(w / h).toFixed(2)}:1`
  return `${rw}:${rh}`
}

/**
 * Describe the framing result for the user.
 * Returns text and a flag indicating whether the framing control should be hidden
 * (when target size == view size AND same aspect ratio).
 *
 * Strings are copied character-for-character from the export modal mockup.
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
  const ar = aspectRatio(targetW, targetH)

  let text: string

  if (mode === 'reveal') {
    if (aspDiff) {
      text = `Anchor-relative at ${ar} — keeps content scale: reveals the ${targetAR > viewAR ? 'wider' : 'taller'} axis, crops the other.`
    } else if (bigger) {
      text = `Bigger frame — reveals more scene around the anchor.`
    } else {
      text = `Smaller frame — crops in to a tighter view around the anchor.`
    }
  } else if (mode === 'fill') {
    if (aspDiff) {
      text = `Fill — composition scaled to cover ${ar}; the ${targetAR > viewAR ? 'top & bottom' : 'sides'} of your view are cropped.`
    } else {
      text = bigger ? `Same composition, supersampled — sharper.` : `Same composition, downscaled.`
    }
  } else {
    // fit
    if (aspDiff) {
      text = `Fit — your whole composition kept; the ${targetAR > viewAR ? 'sides' : 'top & bottom'} fill with revealed scene.`
    } else {
      text = bigger ? `Same composition, supersampled — sharper.` : `Same composition, downscaled.`
    }
  }

  return { text, framingHidden: false }
}
