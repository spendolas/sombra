/**
 * SRT (scale-rotate-translate) op-list — the SINGLE SOURCE for the framework
 * spatial transform. Every SRT emitter routes through here: the WGSL backend
 * (lowerSpatialTransformToWGSL), the IR→GLSL backend (lowerSpatialTransformToGLSL),
 * and the legacy string GLSL generator. Previously the compose order was
 * hand-written in all three (agreeing only by hand-verification, pinned by no
 * gate). Now the ORDER lives once, here; a backend supplies only syntax.
 *
 * See docs/research/2026-08-20-srt-api-design-spec.md.
 *
 * The transform maps an OUTPUT coordinate to the coordinate the node evaluates
 * at (it is the inverse of the visible transform, hence /scale, and translate
 * subtracted). Canonical op order about the anchor: translate (world frame),
 * subAnchor, scale, rotate, addAnchor.
 *
 * ONE STORAGE (DECIDED 2026-08-20): the shader has exactly ONE translate
 * semantic — `srt_translateX/Y` always store the offset in the WORLD frame
 * (the fixed canvas), applied before the anchor/scale/rotate block, so an
 * Offset is a constant canvas nudge regardless of scale or rotation.
 *
 * The Offset Space param (`srt_translateSpace`, 'world' | 'node') never reaches
 * the shader: it is a VIEW/edit mode — how the sliders and the future gizmo
 * interpret coords. In 'node' view, offsets are displayed/edited along the
 * node's rotated+scaled axes and converted to the world storage on write
 * (worldOffsetToNode / nodeOffsetToWorld below). Legacy stored values
 * 'screen'/'local' normalize via normalizeTranslateSpace — the ONE place that
 * alias mapping lives. Pre-one-storage saves are converted on load by
 * src/utils/srt-migration.ts using nodeOffsetToWorld.
 */
import type { IRSpatialTransform, TranslateSpace } from './types'

/**
 * Normalize a stored srt_translateSpace param value to the canonical
 * TranslateSpace. Accepts the legacy 'screen'/'local' values (pre-rename saves)
 * and anything unknown falls back to the default 'world'.
 */
export function normalizeTranslateSpace(value: unknown): TranslateSpace {
  if (value === 'node' || value === 'local') return 'node'
  return 'world' // 'world', legacy 'screen', unset, or unknown
}

/**
 * Offset frame conversions — the SRT math the edit layer (sliders, gizmo) and
 * the load-time migration share. Derivation: the emit below samples at
 * R(θ)·S⁻¹·(c − t_world − anchor) + anchor; the legacy node-frame emit sampled
 * at R(θ)·S⁻¹·(c − anchor) − t_node + anchor. Identical renders ⇔
 * t_world = S·R(−θ)·t_node  (and inversely t_node = R(θ)·S⁻¹·t_world),
 * where t = (tx, −ty) — the shader's y-negated offset vector ("+Y is up").
 */
export function nodeOffsetToWorld(
  tx: number, ty: number, rotateDeg: number, scaleX: number, scaleY: number,
): { tx: number; ty: number } {
  const rad = (rotateDeg * Math.PI) / 180
  const c = Math.cos(rad), s = Math.sin(rad)
  const ax = tx, ay = -ty
  // R(−θ)·a, then per-axis scale
  const rx = c * ax + s * ay
  const ry = -s * ax + c * ay
  return { tx: scaleX * rx, ty: -(scaleY * ry) }
}

export function worldOffsetToNode(
  tx: number, ty: number, rotateDeg: number, scaleX: number, scaleY: number,
): { tx: number; ty: number } {
  // View-only inverse; guard degenerate scale (param min is 0) — at scale≈0
  // the node frame is undefined, fall back to axis scale 1 for display.
  const sx = Math.abs(scaleX) < 1e-6 ? 1 : scaleX
  const sy = Math.abs(scaleY) < 1e-6 ? 1 : scaleY
  const rad = (rotateDeg * Math.PI) / 180
  const c = Math.cos(rad), s = Math.sin(rad)
  const ux = tx / sx, uy = -ty / sy
  // R(θ)·u
  const nx = c * ux - s * uy
  const ny = s * ux + c * uy
  return { tx: nx, ty: -ny }
}

export function emitSRT(srt: IRSpatialTransform, lang: 'glsl' | 'wgsl'): string[] {
  const w = lang === 'wgsl'
  const v = srt.outputVar
  const v2 = w ? 'vec2f' : 'vec2'
  const declV = w ? `var ${v}: vec2f =` : `vec2 ${v} =`
  const letF = (n: string) => (w ? `let ${n}: f32 =` : `float ${n} =`)

  // Basis options — every default reproduces the CANONICAL lowering exactly, so
  // omitting `basis` is byte-identical to before (verify:srt gate C byte-pins it).
  const b = srt.basis ?? {}
  const subAnchor = b.screenAnchor ? `${w ? 'vec2f' : 'vec2'}(u_anchor.x, 1.0 - u_anchor.y)` : 'u_anchor'
  const flipY = b.flipY === true
  const conj = b.aspectConjugate === true
  const asp = b.asp
  const tOrder = b.translateOrder ?? 'world'
  const anchorAdd = b.anchorAdd !== false

  const hasTranslate = !!(srt.translateXUniform && srt.translateYUniform)
  // Pixel Offset → UV. Y negated so +Offset Y reads as "up". 'ref' = isotropic
  // frozen-ref units; 'screen' = per-axis screen units (reeded's colour basis).
  const tExpr = hasTranslate
    ? (b.translateFormula === 'screen'
        ? `${v2}(${srt.translateXUniform}, -(${srt.translateYUniform})) * u_dpr / u_resolution`
        : `${v2}(${srt.translateXUniform}, -(${srt.translateYUniform})) / (u_dpr * u_ref_size)`)
    : null

  const lines: string[] = []

  // 1. Opening. WORLD order folds translate into the opening decl (the canonical
  //    one-semantic path). NODE order (and the no-translate case) subAnchors only
  //    here and applies translate after rotate. flipY negates Y for a y-up basis.
  if (tOrder === 'world' && tExpr) {
    lines.push(`${declV} ${srt.coordsVar} - ${tExpr};`)
    lines.push(`${v} -= ${subAnchor};`)
  } else if (flipY) {
    lines.push(`${declV} ${v2}(${srt.coordsVar}.x - ${subAnchor}.x, -(${srt.coordsVar}.y - ${subAnchor}.y));`)
  } else {
    lines.push(`${declV} ${srt.coordsVar} - ${subAnchor};`)
  }

  // 2. Scale (coords /= scale, so scale=2 → content twice as large).
  if (srt.scaleUniform) {
    lines.push(`${v} /= ${v2}(${srt.scaleUniform});`)
  } else if (srt.scaleXUniform && srt.scaleYUniform) {
    lines.push(`${v} /= ${v2}(${srt.scaleXUniform}, ${srt.scaleYUniform});`)
  }

  // 3. Rotate. Isotropic (canonical ref space, resolution-independent) or, for
  //    per-axis screen space, aspect-conjugated so the rotation stays rigid.
  if (srt.rotateUniform) {
    const rad = `${v}_rad`, c = `${v}_c`, s = `${v}_s`
    lines.push(`${letF(rad)} ${srt.rotateUniform} * 0.01745329;`)
    lines.push(`${letF(c)} cos(${rad}); ${letF(s)} sin(${rad});`)
    if (conj) lines.push(`${v}.x *= ${asp};`)
    lines.push(`${v} = ${v2}(${v}.x * ${c} - ${v}.y * ${s}, ${v}.x * ${s} + ${v}.y * ${c});`)
    if (conj) lines.push(`${v}.x /= ${asp};`)
  }

  // 4. NODE-order translate lands here, after rotate.
  if (tOrder === 'node' && tExpr) {
    lines.push(`${v} -= ${tExpr};`)
  }

  // 5. Back to anchor-relative (unless the basis stays anchor-relative).
  if (anchorAdd) lines.push(`${v} += u_anchor;`)
  return lines
}
