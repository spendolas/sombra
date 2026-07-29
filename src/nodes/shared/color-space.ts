/**
 * sRGB <-> linear-light helpers, shared by every node that AVERAGES colour.
 *
 * Averaging must happen in linear light. Render targets are plain `rgba8unorm` /
 * `RGBA8` with no colour management, so a texel holds an sRGB-ENCODED value —
 * averaging those directly is averaging the wrong numbers. Measured on the blur
 * bake-off: about 12% of the energy goes missing, and bright/dark boundaries grow
 * dark halos. The error scales with the CONTRAST between the samples being
 * averaged, so it is worst exactly where a wide gather or a strong minification
 * pulls in distant, differently-lit texels.
 *
 * The dither is not decoration. Encoding a linear average back to 8 bits
 * quantises to 256 levels, and a wide average produces exactly the smooth,
 * low-frequency content that shows banding. One LSB of noise breaks the contours
 * up; it compounds per pass, which is why it belongs at the point of encoding.
 *
 * These lived in `blur.ts` as `sombra_blur_*` until reeded-glass needed the same
 * three functions. Two copies of a colour transform is how the two halves of that
 * node drifted apart in the first place, so they are hoisted rather than pasted.
 * Names dropped the `blur_` infix because they are no longer blur's; the emitted
 * maths is byte-identical.
 */

import { raw } from '../../compiler/ir/types'
import type { IRFunction } from '../../compiler/ir/types'

/** For `ctx.functionRegistry` / `addFunction` on the string-GLSL path. */
export const COLOR_GLSL_HELPERS = `vec3 sombra_toLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 sombra_toSrgb(vec3 c) {
  vec3 v = max(c, vec3(0.0));
  return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
}
float sombra_dither(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}`

/** The same three as IR functions, so the WGSL backend emits real signatures. */
export const COLOR_IR_HELPERS: IRFunction[] = [
  {
    key: 'sombra_toLin',
    name: 'sombra_toLin',
    params: [{ name: 'c', type: 'vec3' }],
    returnType: 'vec3',
    body: [
      raw(
        '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));',
        '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), step(vec3f(0.04045), c));',
      ),
    ],
  },
  {
    key: 'sombra_toSrgb',
    name: 'sombra_toSrgb',
    params: [{ name: 'c', type: 'vec3' }],
    returnType: 'vec3',
    body: [
      raw(
        '  vec3 v = max(c, vec3(0.0));\n  return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));',
        '  let v = max(c, vec3f(0.0));\n  return mix(v * 12.92, 1.055 * pow(v, vec3f(1.0 / 2.4)) - 0.055, step(vec3f(0.0031308), v));',
      ),
    ],
  },
  {
    key: 'sombra_dither',
    name: 'sombra_dither',
    params: [{ name: 'p', type: 'vec2' }],
    returnType: 'float',
    body: [
      raw(
        '  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);',
        '  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);',
      ),
    ],
  },
]
