/**
 * Per-pass render-target sizing for `RenderPass.resolution`.
 *
 * ONE implementation, shared by both main renderers and both preview renderers.
 * The `dpr` rule below is the entire correctness argument for per-pass
 * resolution, and two copies of it would drift apart — which is exactly how the
 * two halves of reeded-glass diverged.
 *
 * Spec: docs/superpowers/specs/2026-07-29-renderpass-resolution-design.md
 */

/** Smallest supported scale. Below this a pass carries no usable signal. */
export const PASS_SCALE_MIN = 1 / 64
/** Largest supported scale. Above 1.0 is supersampling. */
export const PASS_SCALE_MAX = 4

export interface PassTargetSize {
  /** Target width in device px. */
  width: number
  /** Target height in device px. */
  height: number
  /**
   * `u_dpr` for this pass. Derived from the ACTUAL integer width, never the
   * requested float: rounding otherwise desynchronises the uniforms from the
   * rasteriser, giving a whole-frame scale error plus an anchor offset — the bug
   * recorded at src/webgl/renderer.ts:838.
   */
  dpr: number
}

/** Clamp a declared scale into range, falling back to 1.0 for nonsense. */
export function normalisePassScale(scale: number | undefined): number {
  if (scale === undefined) return 1
  if (!Number.isFinite(scale) || scale <= 0) {
    console.warn(`[Sombra] pass resolution ${scale} is not a positive finite number — using 1.0`)
    return 1
  }
  return Math.min(PASS_SCALE_MAX, Math.max(PASS_SCALE_MIN, scale))
}

/**
 * Target size and matching `u_dpr` for one pass.
 *
 * `canvasWidth`/`canvasHeight` are the FULL render size in device px (i.e.
 * already dpr-multiplied), and `baseDpr` is the `u_dpr` a full-resolution pass
 * would receive.
 */
export function passTargetSize(
  scale: number | undefined,
  canvasWidth: number,
  canvasHeight: number,
  baseDpr: number,
  maxTexture: number,
  minPx = 1,
): PassTargetSize {
  const s = normalisePassScale(scale)
  const lo = Math.max(1, Math.floor(minPx))
  const hi = Math.max(lo, Math.floor(maxTexture))
  const clamp = (v: number) => Math.min(hi, Math.max(lo, Math.round(v)))
  const width = clamp(canvasWidth * s)
  const height = clamp(canvasHeight * s)
  return { width, height, dpr: baseDpr * (width / Math.max(1, canvasWidth)) }
}
