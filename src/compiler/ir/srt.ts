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
 * `translateSpace` (default 'screen') decides WHERE translate lands:
 *   - 'screen' (independent): translate is applied in screen space, BEFORE the
 *     anchor/scale/rotate block, so an Offset is a constant screen nudge — the
 *     content moves by exactly T regardless of scale or rotation.
 *   - 'local': translate is applied inside the scaled+rotated frame (the legacy
 *     behaviour), so the Offset distance scales and its direction rotates.
 * At scale=1 & rotate=0 the two are identical, so default params (scale 1 /
 * rotate 0 / translate 0) render byte-identically to before.
 */
import type { IRSpatialTransform } from './types'

export function emitSRT(srt: IRSpatialTransform, lang: 'glsl' | 'wgsl'): string[] {
  const w = lang === 'wgsl'
  const v = srt.outputVar
  const v2 = w ? 'vec2f' : 'vec2'
  const declV = w ? `var ${v}: vec2f =` : `vec2 ${v} =`
  const letF = (n: string) => (w ? `let ${n}: f32 =` : `float ${n} =`)
  const space = srt.translateSpace ?? 'screen'
  const hasTranslate = !!(srt.translateXUniform && srt.translateYUniform)
  // Pixel Offset → frozen-ref UV. Y negated so +Offset Y reads as "up".
  const tExpr = hasTranslate
    ? `${v2}(${srt.translateXUniform}, -(${srt.translateYUniform})) / (u_dpr * u_ref_size)`
    : null

  const lines: string[] = []

  // 1. Start from coords. In 'screen' mode the translate is applied here, in
  //    screen space, before the anchor/scale/rotate block.
  if (space === 'screen' && tExpr) {
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

  // 4. Translate ('local' mode): inside the scaled+rotated frame.
  if (space !== 'screen' && tExpr) {
    lines.push(`${v} -= ${tExpr};`)
  }

  // 5. Back to anchor-relative.
  lines.push(`${v} += u_anchor;`)
  return lines
}
