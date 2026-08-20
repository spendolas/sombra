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
 * subtracted). Canonical op order about the anchor: subAnchor, scale, rotate,
 * translate, addAnchor.
 *
 * `translateSpace` (default 'world') decides WHERE translate lands:
 *   - 'world' (independent): translate is applied in the fixed canvas frame,
 *     BEFORE the anchor/scale/rotate block, so an Offset is a constant screen
 *     nudge — the content moves by exactly T regardless of scale or rotation.
 *   - 'node': translate is applied inside the node's scaled+rotated frame (the
 *     legacy behaviour), so the Offset distance scales and its direction rotates.
 * At scale=1 & rotate=0 the two are identical, so default params (scale 1 /
 * rotate 0 / translate 0) render byte-identically to before.
 *
 * Naming: World / node matches the gizmo coordinate switch (Blender-style
 * global/local axes). 'screen' and 'local' are accepted as legacy aliases on
 * read — normalizeTranslateSpace is the ONE place that mapping lives.
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

export function emitSRT(srt: IRSpatialTransform, lang: 'glsl' | 'wgsl'): string[] {
  const w = lang === 'wgsl'
  const v = srt.outputVar
  const v2 = w ? 'vec2f' : 'vec2'
  const declV = w ? `var ${v}: vec2f =` : `vec2 ${v} =`
  const letF = (n: string) => (w ? `let ${n}: f32 =` : `float ${n} =`)
  const space = normalizeTranslateSpace(srt.translateSpace)
  const hasTranslate = !!(srt.translateXUniform && srt.translateYUniform)
  // Pixel Offset → frozen-ref UV. Y negated so +Offset Y reads as "up".
  const tExpr = hasTranslate
    ? `${v2}(${srt.translateXUniform}, -(${srt.translateYUniform})) / (u_dpr * u_ref_size)`
    : null

  const lines: string[] = []

  // 1. Start from coords. In 'world' mode the translate is applied here, in
  //    the fixed canvas frame, before the anchor/scale/rotate block.
  if (space === 'world' && tExpr) {
    lines.push(`${declV} ${srt.coordsVar} - ${tExpr};`)
    lines.push(`${v} -= u_anchor;`)
  } else {
    lines.push(`${declV} ${srt.coordsVar} - u_anchor;`)
  }

  // 2. Scale (coords /= scale, so scale=2 → content twice as large).
  if (srt.scaleUniform) {
    lines.push(`${v} /= ${v2}(${srt.scaleUniform});`)
  } else if (srt.scaleXUniform && srt.scaleYUniform) {
    lines.push(`${v} /= ${v2}(${srt.scaleXUniform}, ${srt.scaleYUniform});`)
  }

  // 3. Rotate. coords are isotropic (auto_uv divides both axes by the frozen
  //    u_ref_size), so a plain rotation is resolution-independent. Degrees.
  if (srt.rotateUniform) {
    const rad = `${v}_rad`, c = `${v}_c`, s = `${v}_s`
    lines.push(`${letF(rad)} ${srt.rotateUniform} * 0.01745329;`)
    lines.push(`${letF(c)} cos(${rad}); ${letF(s)} sin(${rad});`)
    lines.push(`${v} = ${v2}(${v}.x * ${c} - ${v}.y * ${s}, ${v}.x * ${s} + ${v}.y * ${c});`)
  }

  // 4. Translate ('node' mode): inside the node's scaled+rotated frame.
  if (space !== 'world' && tExpr) {
    lines.push(`${v} -= ${tExpr};`)
  }

  // 5. Back to anchor-relative.
  lines.push(`${v} += u_anchor;`)
  return lines
}
