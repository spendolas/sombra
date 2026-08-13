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
 * - match: the view's device pixels (cssW*deviceDpr, cssH*deviceDpr)
 * - mul: view device px × factor
 * - preset/custom: literal dimensions
 */
export function targetSize(src: SizeSource, view: ViewInfo): { width: number; height: number } {
  switch (src.kind) {
    case 'match':
      return {
        width: view.cssW * view.deviceDpr,
        height: view.cssH * view.deviceDpr,
      }
    case 'mul':
      return {
        width: view.cssW * view.deviceDpr * src.factor,
        height: view.cssH * view.deviceDpr * src.factor,
      }
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

// Helper: format aspect ratio as simplified string (e.g., "16:9")
function aspectRatio(w: number, h: number): string {
  const g = gcd(Math.round(w), Math.round(h)) || 1
  return `${Math.round(w / g)}:${Math.round(h / g)}`
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

  // Compute view in device pixels for comparison
  const viewDeviceW = view.cssW * view.deviceDpr
  const viewDeviceH = view.cssH * view.deviceDpr

  const sizeDiff = targetW !== viewDeviceW || targetH !== viewDeviceH
  const targetAR = targetW / targetH
  const viewAR = viewDeviceW / viewDeviceH
  const aspDiff = Math.abs(targetAR - viewAR) > 0.01

  // Hidden case: no size difference and no aspect ratio difference
  if (!sizeDiff && !aspDiff) {
    return { text: 'Exporting your current view exactly, 1:1.', framingHidden: true }
  }

  const bigger = targetW * targetH >= viewDeviceW * viewDeviceH
  const ar = aspectRatio(targetW, targetH)

  let text: string

  if (mode === 'reveal') {
    if (aspDiff) {
      text = `Anchor-relative at ${ar} — keeps content scale: reveals the ${targetAR > viewAR ? 'wider' : 'taller'} axis, crops the other. No bars.`
    } else if (bigger) {
      text = `Bigger frame — reveals more scene around the anchor. No bars.`
    } else {
      text = `Smaller frame — crops in to a tighter view around the anchor.`
    }
  } else if (mode === 'fill') {
    if (aspDiff) {
      text = `Fill — composition scaled to cover ${ar}; the ${targetAR > viewAR ? 'top & bottom' : 'sides'} of your view are cropped. No bars.`
    } else {
      text = bigger ? `Same composition, supersampled — sharper.` : `Same composition, downscaled.`
    }
  } else {
    // fit
    if (aspDiff) {
      text = `Fit — your whole composition kept; the ${targetAR > viewAR ? 'sides' : 'top & bottom'} fill with revealed scene, not bars.`
    } else {
      text = bigger ? `Same composition, supersampled — sharper.` : `Same composition, downscaled.`
    }
  }

  return { text, framingHidden: false }
}
