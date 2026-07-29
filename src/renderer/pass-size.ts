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

/**
 * Clamp a declared scale into range, falling back to 1.0 for nonsense.
 *
 * SILENT on purpose. This runs inside `passTargetSizes`, which both main
 * renderers call 2–3× per frame — once per pass — so a warning here on a plan
 * carrying `resolution: -1` would emit hundreds of lines per second. Validation
 * belongs to the producer, which has the node identity to name:
 * `resolvePassResolution` (src/compiler/pass-resolution.ts) already drops
 * non-finite and `<= 0` scales at compile time and warns with the node type. A
 * decoded `.ombra` artifact does not go through that check, so a corrupt or
 * hand-edited plan reaches this helper directly — it is clamped to a safe 1.0
 * either way, which is the behaviour that matters at 60 fps.
 */
export function normalisePassScale(scale: number | undefined): number {
  if (scale === undefined) return 1
  if (!Number.isFinite(scale) || scale <= 0) return 1
  return Math.min(PASS_SCALE_MAX, Math.max(PASS_SCALE_MIN, scale))
}

/**
 * Target size and matching `u_dpr` for one pass.
 *
 * `canvasWidth`/`canvasHeight` are the FULL render size in device px (i.e.
 * already dpr-multiplied), and `baseDpr` is the `u_dpr` a full-resolution pass
 * would receive.
 *
 * A single scalar `dpr` is only correct if both axes land at the SAME
 * effective scale, so `width` and `height` are never clamped independently:
 * one axis hitting `maxTexture` while the other doesn't would decouple the
 * axes, leaving the returned `dpr` (derived from width) correct for X and
 * silently wrong for Y. Concretely, a 5K canvas at dpr 2 (10240×5760) against
 * an 8192 `maxTexture` clamps X to 8192/10240 = 0.8 of its size while leaving
 * Y unclamped at 1.0 — a 25% error on Y, not a rounding footnote. Instead, one
 * effective scale is derived from BOTH axes — capped by the tighter of the two
 * `maxTexture` ceilings, floored by the looser of the two `minPx` floors — and
 * applied to both, so `width/canvasWidth` and `height/canvasHeight` agree up
 * to final integer rounding.
 *
 * If the ceiling and floor can't both be satisfied for a given canvas aspect
 * ratio (`sFloor > sCeiling` — an aspect ratio beyond `maxTexture / minPx`),
 * the ceiling wins: `sEff = sCeiling`, since `maxTexture` is a hardware limit
 * that must never be exceeded, while `minPx` is only a soft quality floor.
 * At that `sEff` the longer axis lands exactly on the ceiling, but the
 * shorter axis would fall under `minPx` — so the final per-axis `clamp()`
 * below forces it back UP to `minPx` instead, and the two axes no longer
 * share one effective scale. Concretely, `passTargetSize(1, 8192, 2, 2, 8192,
 * 4)` returns `{ width: 8192, height: 4, dpr: 2 }`: ratioX = 8192/8192 = 1
 * but ratioY = 4/2 = 2, so `dpr` — always derived from width, correct for X
 * by construction — is silently wrong for Y (should be 4, is 2). This branch
 * is not reachable by any canvas size / texture-limit combination this
 * application's callers actually hit: the main renderers call with
 * `minPx = 1` and `maxTexture >= 4096`, which needs an aspect ratio beyond
 * 4096:1 to trigger, and the preview renderers always call with a square
 * 80×80 canvas. Documented here so a future reader recognises this as an
 * accepted corner, not an oversight.
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
  // Guard against a degenerate 0-sized canvas dimension the same way the dpr
  // divisor below always has — never as a divisor without it.
  const safeWidth = Math.max(1, canvasWidth)
  const safeHeight = Math.max(1, canvasHeight)

  // One scale, chosen so NEITHER axis can exceed `hi` and (bounds permitting)
  // NEITHER axis can drop below `lo`, then applied to both axes alike.
  const sCeiling = hi / Math.max(safeWidth, safeHeight)
  const sFloor = lo / Math.min(safeWidth, safeHeight)
  const sEff = Math.min(sCeiling, Math.max(s, sFloor))

  // Final clamp is a no-op in every reachable case (sEff already respects
  // both bounds); it only guards float rounding at the boundary. The one
  // case where it does real work — forcing the shorter axis up to `minPx`
  // when the ceiling/floor conflict — is the unreachable fallback documented
  // above.
  const clamp = (v: number) => Math.min(hi, Math.max(lo, Math.round(v)))
  const width = clamp(canvasWidth * sEff)
  const height = clamp(canvasHeight * sEff)
  return { width, height, dpr: baseDpr * (width / safeWidth) }
}
