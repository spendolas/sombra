/**
 * Blend-mode helper library — the `B(c_b, c_s)` term of the compositing model.
 *
 * 24 modes: 20 separable (per channel) and 4 non-separable (Hue, Saturation,
 * Colour, Luminosity) built on the PDF / W3C Compositing `Lum` / `ClipColor` /
 * `SetLum` / `Sat` / `SetSat` helpers. Formulas follow the W3C Compositing and
 * Blending Level 1 spec where it defines a mode, and Photoshop's published
 * definitions for the ones it does not (Linear Burn/Dodge, Vivid/Linear/Pin
 * Light, Hard Mix, Subtract, Divide).
 *
 * Every helper takes the BACKDROP first and the SOURCE second, both straight
 * (non-premultiplied) colour in [0,1], and returns the blended colour. Alpha is
 * not this file's concern — the caller composites `B` with the alpha-aware over
 * (spec §3). Callers clamp their inputs to [0,1]; the helpers rely on it (Soft
 * Light takes `sqrt(b)`).
 *
 * Degenerate guards live HERE, in each helper: Colour Burn, Colour Dodge and
 * Divide divide by the source (or its complement), and Clip Color divides by a
 * luminance spread that is zero for a grey. Every branch a helper selects
 * between is finite on every [0,1] input, because `mix(a, b, 1.0)` is
 * `a * 0.0 + b` on some GPUs and `Inf * 0.0` is NaN — guarding only the branch
 * that "wins" is not enough.
 *
 * ONE SOURCE, BOTH BACKENDS. Each helper is an `IRFunction` whose body is a
 * single-arg `raw()` — one GLSL text that the WGSL backend translates
 * mechanically (`wgsl-backend.ts`), never a hand-written second copy. The GLSL
 * path gets its text by lowering the SAME `IRFunction` (`lowerFunctionToGLSL`),
 * and registers it under the same key, so the two paths cannot disagree about
 * the text or about the dedup key. Bodies are written in the translator's
 * subset: every vector operand of `min`/`max`/`step`/`clamp` is a vector (WGSL
 * has no scalar overloads for those), declarations start the line, and
 * conditionals use braces.
 *
 * Only the modes a graph uses are emitted: callers ask for one mode's functions
 * (`blendIRFunctions` / `addBlendGLSL`), which bring their dependencies with
 * them, and the assembler / `addFunction` dedup by key.
 */

import { raw } from '../../compiler/ir/types'
import type { IRFunction, IRType } from '../../compiler/ir/types'
import { lowerFunctionToGLSL } from '../../compiler/ir/glsl-backend'
import { addFunction } from '../types'
import type { GLSLContext } from '../types'

export type BlendMode =
  | 'normal' | 'darken' | 'multiply' | 'colorBurn' | 'linearBurn'
  | 'lighten' | 'screen' | 'colorDodge' | 'linearDodge'
  | 'overlay' | 'softLight' | 'hardLight' | 'vividLight' | 'linearLight' | 'pinLight' | 'hardMix'
  | 'difference' | 'exclusion' | 'subtract' | 'divide'
  | 'hue' | 'saturation' | 'color' | 'luminosity'

/** Display order and labels — the signed-off layer list's menu (sandbox `stack-layer-list`). */
export const BLEND_MODES: ReadonlyArray<{ id: BlendMode; label: string; separable: boolean }> = [
  { id: 'normal', label: 'Normal', separable: true },
  { id: 'darken', label: 'Darken', separable: true },
  { id: 'multiply', label: 'Multiply', separable: true },
  { id: 'colorBurn', label: 'Colour Burn', separable: true },
  { id: 'linearBurn', label: 'Linear Burn', separable: true },
  { id: 'lighten', label: 'Lighten', separable: true },
  { id: 'screen', label: 'Screen', separable: true },
  { id: 'colorDodge', label: 'Colour Dodge', separable: true },
  { id: 'linearDodge', label: 'Linear Dodge (Add)', separable: true },
  { id: 'overlay', label: 'Overlay', separable: true },
  { id: 'softLight', label: 'Soft Light', separable: true },
  { id: 'hardLight', label: 'Hard Light', separable: true },
  { id: 'vividLight', label: 'Vivid Light', separable: true },
  { id: 'linearLight', label: 'Linear Light', separable: true },
  { id: 'pinLight', label: 'Pin Light', separable: true },
  { id: 'hardMix', label: 'Hard Mix', separable: true },
  { id: 'difference', label: 'Difference', separable: true },
  { id: 'exclusion', label: 'Exclusion', separable: true },
  { id: 'subtract', label: 'Subtract', separable: true },
  { id: 'divide', label: 'Divide', separable: true },
  { id: 'hue', label: 'Hue', separable: false },
  { id: 'saturation', label: 'Saturation', separable: false },
  { id: 'color', label: 'Colour', separable: false },
  { id: 'luminosity', label: 'Luminosity', separable: false },
]

export function isBlendMode(v: unknown): v is BlendMode {
  return BLEND_MODES.some((m) => m.id === v)
}

/** Name of the emitted `vec3 fn(vec3 backdrop, vec3 source)` for a mode. */
export function blendFunctionName(mode: BlendMode): string {
  return `sombra_blend_${mode}`
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** Guard for denominators that may be zero on a [0,1] input. */
const EPS = '0.000001'

function fn(
  name: string,
  params: Array<{ name: string; type: IRType }>,
  returnType: IRType,
  body: string,
): IRFunction {
  return { key: name, name, params, returnType, body: [raw(body)] }
}

const BS = [{ name: 'b', type: 'vec3' as const }, { name: 's', type: 'vec3' as const }]
const mode = (id: BlendMode, body: string) => fn(blendFunctionName(id), BS, 'vec3', body)

/** `t` = 1 where x > 0.5, else 0 — the threshold the "light" modes branch on. */
const ABOVE_HALF = (x: string) => `vec3(1.0) - step(${x}, vec3(0.5))`

// Non-separable building blocks (W3C Compositing §10.2.4).
const LUM = fn('sombra_blend_lum', [{ name: 'c', type: 'vec3' }], 'float',
  `  return dot(c, vec3(0.3, 0.59, 0.11));`)
const CLIP_COLOR = fn('sombra_blend_clipColor', [{ name: 'c', type: 'vec3' }], 'vec3',
  `  float l = sombra_blend_lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  vec3 r = c;
  if (n < 0.0) {
    r = vec3(l) + (r - vec3(l)) * l / max(l - n, ${EPS});
  }
  if (x > 1.0) {
    r = vec3(l) + (r - vec3(l)) * (1.0 - l) / max(x - l, ${EPS});
  }
  return r;`)
const SET_LUM = fn('sombra_blend_setLum', [{ name: 'c', type: 'vec3' }, { name: 'l', type: 'float' }], 'vec3',
  `  float d = l - sombra_blend_lum(c);
  return sombra_blend_clipColor(c + vec3(d));`)
const SAT = fn('sombra_blend_sat', [{ name: 'c', type: 'vec3' }], 'float',
  `  return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));`)
// The W3C algorithm sorts the channels into min/mid/max; the vector form below
// gives max → s, min → 0, mid → (mid-min)·s/(max-min), and the same answers for
// ties, without the sort.
const SET_SAT = fn('sombra_blend_setSat', [{ name: 'c', type: 'vec3' }, { name: 'sat', type: 'float' }], 'vec3',
  `  float mn = min(c.r, min(c.g, c.b));
  float mx = max(c.r, max(c.g, c.b));
  if (mx > mn) {
    return (c - vec3(mn)) * sat / (mx - mn);
  }
  return vec3(0.0);`)
const NON_SEPARABLE_DEPS = [LUM, CLIP_COLOR, SET_LUM, SAT, SET_SAT]

const COLOR_BURN = mode('colorBurn',
  // b == 1 → 1; else s == 0 → 0; else 1 - min(1, (1-b)/s)
  `  vec3 r = vec3(1.0) - min(vec3(1.0), (vec3(1.0) - b) / max(s, vec3(${EPS})));
  r = mix(r, vec3(0.0), step(s, vec3(0.0)));
  return mix(r, vec3(1.0), step(vec3(1.0), b));`)
const COLOR_DODGE = mode('colorDodge',
  // b == 0 → 0; else s == 1 → 1; else min(1, b/(1-s))
  `  vec3 r = min(vec3(1.0), b / max(vec3(1.0) - s, vec3(${EPS})));
  r = mix(r, vec3(1.0), step(vec3(1.0), s));
  return mix(r, vec3(0.0), step(b, vec3(0.0)));`)

/** Each mode's own function plus whatever it calls, dependencies first. */
const DEFINITIONS: Record<BlendMode, IRFunction[]> = {
  normal: [mode('normal', `  return s;`)],
  darken: [mode('darken', `  return min(b, s);`)],
  multiply: [mode('multiply', `  return b * s;`)],
  colorBurn: [COLOR_BURN],
  linearBurn: [mode('linearBurn', `  return max(b + s - vec3(1.0), vec3(0.0));`)],
  lighten: [mode('lighten', `  return max(b, s);`)],
  screen: [mode('screen', `  return b + s - b * s;`)],
  colorDodge: [COLOR_DODGE],
  linearDodge: [mode('linearDodge', `  return min(b + s, vec3(1.0));`)],
  // Overlay is Hard Light with the operands swapped: it thresholds on the backdrop.
  overlay: [mode('overlay',
    `  vec3 lo = 2.0 * b * s;
  vec3 hi = vec3(1.0) - 2.0 * (vec3(1.0) - b) * (vec3(1.0) - s);
  return mix(lo, hi, ${ABOVE_HALF('b')});`)],
  softLight: [mode('softLight',
    `  vec3 d = mix(((16.0 * b - vec3(12.0)) * b + vec3(4.0)) * b, sqrt(b), vec3(1.0) - step(b, vec3(0.25)));
  vec3 lo = b - (vec3(1.0) - 2.0 * s) * b * (vec3(1.0) - b);
  vec3 hi = b + (2.0 * s - vec3(1.0)) * (d - b);
  return mix(lo, hi, ${ABOVE_HALF('s')});`)],
  hardLight: [mode('hardLight',
    `  vec3 lo = 2.0 * b * s;
  vec3 hi = vec3(1.0) - 2.0 * (vec3(1.0) - b) * (vec3(1.0) - s);
  return mix(lo, hi, ${ABOVE_HALF('s')});`)],
  vividLight: [COLOR_BURN, COLOR_DODGE, mode('vividLight',
    `  vec3 lo = ${blendFunctionName('colorBurn')}(b, 2.0 * s);
  vec3 hi = ${blendFunctionName('colorDodge')}(b, 2.0 * (s - vec3(0.5)));
  return mix(lo, hi, ${ABOVE_HALF('s')});`)],
  linearLight: [mode('linearLight', `  return clamp(b + 2.0 * s - vec3(1.0), vec3(0.0), vec3(1.0));`)],
  pinLight: [mode('pinLight',
    `  return mix(min(b, 2.0 * s), max(b, 2.0 * s - vec3(1.0)), ${ABOVE_HALF('s')});`)],
  hardMix: [mode('hardMix', `  return step(vec3(1.0), b + s);`)],
  difference: [mode('difference', `  return abs(b - s);`)],
  exclusion: [mode('exclusion', `  return b + s - 2.0 * b * s;`)],
  subtract: [mode('subtract', `  return max(b - s, vec3(0.0));`)],
  divide: [mode('divide',
    // b == 0 → 0; else s == 0 → 1; else min(1, b/s)
    `  vec3 r = min(vec3(1.0), b / max(s, vec3(${EPS})));
  r = mix(r, vec3(1.0), step(s, vec3(0.0)));
  return mix(r, vec3(0.0), step(b, vec3(0.0)));`)],
  hue: [...NON_SEPARABLE_DEPS, mode('hue',
    `  return sombra_blend_setLum(sombra_blend_setSat(s, sombra_blend_sat(b)), sombra_blend_lum(b));`)],
  saturation: [...NON_SEPARABLE_DEPS, mode('saturation',
    `  return sombra_blend_setLum(sombra_blend_setSat(b, sombra_blend_sat(s)), sombra_blend_lum(b));`)],
  color: [...NON_SEPARABLE_DEPS, mode('color', `  return sombra_blend_setLum(s, sombra_blend_lum(b));`)],
  luminosity: [...NON_SEPARABLE_DEPS, mode('luminosity', `  return sombra_blend_setLum(b, sombra_blend_lum(s));`)],
}

// ---------------------------------------------------------------------------
// Registration — one per path, same keys on both
// ---------------------------------------------------------------------------

/** IR path: the functions to put in a node's `functions`, dependencies first. */
export function blendIRFunctions(mode: BlendMode): IRFunction[] {
  return DEFINITIONS[mode]
}

/**
 * GLSL path: register `mode`'s helper and its dependencies on `ctx` (idempotent,
 * dependencies first so GLSL sees each definition before its use) and return
 * the function name to call.
 */
export function addBlendGLSL(ctx: GLSLContext, mode: BlendMode): string {
  for (const f of DEFINITIONS[mode]) addFunction(ctx, f.key, lowerFunctionToGLSL(f))
  return blendFunctionName(mode)
}
