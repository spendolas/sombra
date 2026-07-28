/**
 * Phase 14 — the MINIFICATION bake-off for Reeded Glass.
 *
 * The node's cross-rib map has a closed-form derivative
 *   L'(local) = 1 - A / (1 - k^2 x^2)^{3/2},  A = (ior-1)*amp*k,  x = 2*local - 1
 * and |L'| > 1 is minification: one screen pixel spans |L'| source pixels while
 * the node takes exactly ONE bilinear tap. The user's scene (curvature 2.15,
 * ior 1.65) minifies over 52.9% of every rib, up to |L'| ~ 200 at a pixel centre.
 *
 * This file builds and CALIBRATES the bench. It does not run the sweep.
 *
 *   npx tsx scripts/blur-bakeoff/phase14-minification.ts --validate   (default)
 *   npx tsx scripts/blur-bakeoff/phase14-minification.ts --sweep      (later)
 *
 * ---------------------------------------------------------------------------
 * HOW CANDIDATES ARE EXPRESSED — and exactly what is emulated
 * ---------------------------------------------------------------------------
 * Every candidate runs the compiler's OWN emitted shader for the real
 * `image -> reeded_glass -> fragment_output` graph, on both backends, and reads
 * the node's OWN seam geometry: `rg_n_*` (unit seam normal), `rg_hw_*` (half the
 * unit pixel's support on that normal), `rg_ss_*`, `rg_gl_*`, `rg_phi_*`. None of
 * that is reimplemented — the emitted body up to the `rg_sampleUV_*` declaration
 * is spliced verbatim into the candidate's entry point.
 *
 * A tap is `sombra_at(off)`: the entire node body re-evaluated at a pixel centre
 * `off` device px away, in fragCoord space. Two things about that are EMULATION
 * rather than what a node change would do, and both are stated in the report:
 *
 *  (E1) `emitLensTail` FIRST-ORDER EXTRAPOLATES the rib phase for a sub-sample
 *       (`wm + offPx * rate * ribUV`) so a tap costs one `reedLens` call and no
 *       wave-field evaluation. `sombra_at` instead re-evaluates the wave field at
 *       the offset point. For straight ribs the two are algebraically identical;
 *       for a sine rib they differ by O(w''/8) over half a pixel. The bench
 *       measures that difference (gate V3b) instead of assuming it away. It makes
 *       the bench's per-tap COST higher than the real fix's (N noise fetches vs
 *       1) and its per-tap POSITION very slightly more accurate.
 *  (E2) Taps are averaged with straight alpha, not premultiplied. Gate V5 asserts
 *       every stimulus and every render is fully opaque, which makes the two
 *       arithmetically identical here. A real node change must still premultiply
 *       (the frost and split arms already do).
 *
 * M3 (slope clamp) is a genuine source patch of the node's own `reedLens`: the
 * floor inside `sqrt(max(1.0 - x2, 0.001))` is raised to `(A/(1+C))^2`, which caps
 * |L'| at exactly C. M5 patches `disp` with the smoothFract-family taper. Both are
 * one-token edits to the emitted text, asserted to apply exactly once.
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildGraph, type ReedCfg, type BuiltGraph } from './phase10-reed-aa.ts'
import { createAaRig, type AaRig, type AaPass, type Backend } from './phase10-aa-rig.ts'
import { decodeSeamField, staircase } from './lib/edge-metrics.ts'
import { encodePng } from './lib/png.ts'
import type { Rgba8 } from './lib/image.ts'
import {
  type FloatImg, type Resid, type LookResult, type SeamTrack,
  zerosF, fromRgba8, toRgba8, addInto, lumaF,
  residual, diffField, bandFromControl, bandFixed, lookDelta, grainRatio, seamTrack, trackSeed,
  causticContrast, temporalExcess,
  addWhiteNoise, scaleContrast, shiftSubpixel, shiftRgba8, gaussBlur,
  lensKA, lensDeriv, supLensDeriv, fracMinifying, slopeClampEps,
} from './phase14-minif-metrics.ts'

const REPO = process.cwd()
const OUT_DIR = path.join(REPO, 'reports', 'blur-bakeoff', 'phase14')

// ===========================================================================
// Frame geometry — matched to the GT-convergence phase so numbers compare
// ===========================================================================

const W = 320
const H = 512
const MARGIN = 6

/** dpr 1.5 = min(devicePixelRatio,2) * ANIMATED_DPR_SCALE(0.75) — the user's
 *  graph is time-live, so this is what their scene actually renders at. */
const DPRS = [1.5, 2] as const

/** Look-metric low-pass sigma, device px. 2-4 px aliasing dies, the 120 px
 *  (dpr 1.5) / 160 px (dpr 2) rib period survives essentially intact. */
const LOOK_SIGMA = 4
/** Grain metric high-pass sigma — smaller, so it is sensitive to per-pixel noise. */
const GRAIN_SIGMA = 1.5

// ===========================================================================
// Configs
// ===========================================================================

interface Cfg { id: string; label: string; cfg: ReedCfg }

const BASE_STRAIGHT: ReedCfg = {
  ribWidth: 80, ior: 1.5, curvature: 0.8, bow: 1, frost: 0,
  direction: 'vertical', ribType: 'straight',
  srt_scale: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
}

/** The user's Reeded Glass settings from `shaders/face dr.sombra`, verbatim. */
const USER_CFG: ReedCfg = {
  ribWidth: 80, ior: 1.65, curvature: 2.15, bow: 2.72, frost: 0,
  direction: 'vertical', ribType: 'wave', waveShape: 'sine',
  amplitude: 20, wavelength: 577,
  srt_scale: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
}

const CONFIGS: Cfg[] = [
  { id: 'defaults', label: 'node defaults (ior 1.50, curv 0.80) — 0% minifies', cfg: { ...BASE_STRAIGHT } },
  { id: 'c085', label: 'curvature 0.85 @ ior 1.5 (just past the cliff)', cfg: { ...BASE_STRAIGHT, curvature: 0.85 } },
  { id: 'c090', label: 'curvature 0.90 @ ior 1.5', cfg: { ...BASE_STRAIGHT, curvature: 0.90 } },
  { id: 'c100', label: 'curvature 1.00 @ ior 1.5', cfg: { ...BASE_STRAIGHT, curvature: 1.00 } },
  { id: 'c150', label: 'curvature 1.50 @ ior 1.5 (prior study case)', cfg: { ...BASE_STRAIGHT, curvature: 1.50 } },
  { id: 'c215', label: 'curvature 2.15 @ ior 1.5', cfg: { ...BASE_STRAIGHT, curvature: 2.15 } },
  { id: 'i154', label: 'ior 1.54 @ curv 0.8 (the exact onset)', cfg: { ...BASE_STRAIGHT, ior: 1.54 } },
  { id: 'i180', label: 'ior 1.80 @ curv 0.8', cfg: { ...BASE_STRAIGHT, ior: 1.80 } },
  { id: 'i250', label: 'ior 2.50 @ curv 0.8 (prior study case)', cfg: { ...BASE_STRAIGHT, ior: 2.50 } },
  { id: 'user', label: "the user's exact scene config (face dr.sombra)", cfg: { ...USER_CFG } },
  {
    id: 'userLowCurv',
    label: "the user's scene at curvature 0.80 / bow 1 — an OBLIQUE seam with no minification, the regime lib/edge-metrics.staircase was calibrated in",
    cfg: { ...USER_CFG, curvature: 0.8, bow: 1 },
  },
]
const CFG_BY_ID: Record<string, Cfg> = Object.fromEntries(CONFIGS.map((c) => [c.id, c]))

// ===========================================================================
// Shader surgery
// ===========================================================================

const WGSL_SIG = /@fragment\s+fn\s+fs_main\s*\(\s*in\s*:\s*VertexOutput\s*\)\s*->\s*@location\(0\)\s*vec4f\s*\{/
const GLSL_SIG = /void\s+main\s*\(\s*\)\s*\{/

type Kind = 'wgsl' | 'glsl'

interface Split {
  prelude: string
  bodyLines: string[]
  /** index of the `rg_sampleUV_<id>` declaration — the cut point */
  uvIdx: number
  /** node id suffix, e.g. `rg` */
  id: string
  /** the ior / curvature expressions the node itself passes to reedLens */
  iorExpr: string
  curvExpr: string
}

function splitShader(code: string, kind: Kind): Split {
  const sig = kind === 'wgsl' ? WGSL_SIG : GLSL_SIG
  const m = sig.exec(code)
  if (!m) throw new Error(`phase14: ${kind} entry point not found — compiler output shape changed`)
  const prelude = code.slice(0, m.index)
  const rest = code.slice(m.index + m[0].length)
  const close = rest.lastIndexOf('}')
  if (close < 0) throw new Error(`phase14: ${kind} entry has no closing brace`)
  const bodyLines = rest.slice(0, close).replace(/\s+$/, '').split('\n')

  const uvRe = kind === 'wgsl'
    ? /^\s*(?:let|var)\s+rg_sampleUV_(\w+?)\s*(?::\s*vec2f\s*)?=/
    : /^\s*vec2\s+rg_sampleUV_(\w+?)\s*=/
  let uvIdx = -1
  let id = ''
  for (let i = 0; i < bodyLines.length; i++) {
    const mm = uvRe.exec(bodyLines[i])
    // `rg_sampleUV_<id>_a` matches the same regex with id = "<id>_a"; the FIRST
    // hit is the centre one, which is the cut point we want.
    if (mm) { uvIdx = i; id = mm[1]; break }
  }
  if (uvIdx < 0) throw new Error(`phase14: ${kind} — rg_sampleUV_* declaration not found`)

  const head = bodyLines.slice(0, uvIdx).join('\n')
  for (const need of [`rg_n_${id}`, `rg_hw_${id}`, `rg_ss_${id}`, `rg_gl_${id}`, `rg_phi_${id}`]) {
    if (!head.includes(need)) throw new Error(`phase14: ${need} is not in scope at the cut point`)
  }

  // Read ior / curvature straight off the node's own screen-side reedLens call,
  // so the closed-form predicate cannot drift from the map it predicts.
  const callRe = new RegExp(`reedLens\\(\\s*rg_swm_${id}\\s*,\\s*rg_ribUV_scr_${id}\\s*,\\s*([^,]+?)\\s*,\\s*([^)]+?)\\s*\\)`)
  const cm = callRe.exec(head)
  if (!cm) throw new Error(`phase14: ${kind} — screen-side reedLens call not found`)

  return { prelude, bodyLines, uvIdx, id, iorExpr: cm[1], curvExpr: cm[2] }
}

/** GLSL entry body -> parameterised function body. */
function glslFnBody(lines: string[]): string {
  return lines.join('\n')
    .replace(/\bgl_FragCoord\b/g, 'sombraFC')
    .replace(/\bv_uv\b/g, 'sombraUV')
    .replace(/\bfragColor\s*=/g, 'return')
}

/** Force the node's seam-coverage split off — phase 12 proved this byte-identical
 *  to the pre-aa082c0 node, so a tap through this body is ONE clean bilinear
 *  fetch and an N-tap sum is exactly the N-tap box integral of the raw map. */
const NOSPLIT_RE = /(rg_split_\w+(?::\s*bool)?\s*=\s*)abs\([^;]*;/
function forceNoSplit(text: string): string {
  if (!NOSPLIT_RE.test(text)) throw new Error('forceNoSplit: rg_split assignment not found')
  const out = text.replace(NOSPLIT_RE, '$1false;')
  if ((out.match(/rg_split_\w+(?::\s*bool)?\s*=\s*false;/) ?? []).length !== 1) {
    throw new Error('forceNoSplit: patch did not apply exactly once')
  }
  return out
}

// ---------------------------------------------------------------------------
// Language shims
// ---------------------------------------------------------------------------

interface Lang {
  kind: Kind
  /** one tap through the SPLIT-DISABLED body, offset in fragCoord-space device px */
  at(off: string): string
  /** one tap through the UNTOUCHED shipped body */
  ship(off: string): string
  v2(x: string, y: string): string
  v4z: string
  letf(n: string, e: string): string
  letv2(n: string, e: string): string
  varf(n: string, e: string): string
  varv4(n: string, e: string): string
  declv4(n: string): string
  assign(n: string, e: string): string
  addTo(n: string, e: string): string
  loop(v: string, n: number, body: string): string
  fi(v: string): string
  sel(cond: string, t: string, f: string): string
  brk: string
  pos: string
  out(e: string): string
  fnum(n: number): string
  /** a y-UP screen-space vector converted to a fragCoord-space offset */
  frag(vx: string, vy: string): string
}

function makeLang(kind: Kind): Lang {
  const fnum = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)
  if (kind === 'wgsl') {
    return {
      kind, fnum,
      at: (o) => `sombra_at(in, ${o})`,
      ship: (o) => `sombra_ship_at(in, ${o})`,
      v2: (x, y) => `vec2f(${x}, ${y})`,
      v4z: 'vec4f(0.0)',
      letf: (n, e) => `let ${n}: f32 = ${e};`,
      letv2: (n, e) => `let ${n}: vec2f = ${e};`,
      varf: (n, e) => `var ${n}: f32 = ${e};`,
      varv4: (n, e) => `var ${n}: vec4f = ${e};`,
      declv4: (n) => `var ${n}: vec4f;`,
      assign: (n, e) => `${n} = ${e};`,
      addTo: (n, e) => `${n} = ${n} + ${e};`,
      loop: (v, n, body) => `for (var ${v}: i32 = 0; ${v} < ${n}; ${v}++) {\n${body}\n  }`,
      fi: (v) => `f32(${v})`,
      sel: (c, t, f) => `select(${f}, ${t}, ${c})`,
      brk: '{ break; }',
      pos: 'in.position.xy',
      out: (e) => `return ${e};`,
      // @builtin(position) is y-DOWN while the node's rg_n / delta are y-UP.
      frag: (vx, vy) => `vec2f(${vx}, -(${vy}))`,
    }
  }
  return {
    kind, fnum,
    at: (o) => `sombra_at(gl_FragCoord, v_uv, ${o})`,
    ship: (o) => `sombra_ship_at(gl_FragCoord, v_uv, ${o})`,
    v2: (x, y) => `vec2(${x}, ${y})`,
    v4z: 'vec4(0.0)',
    letf: (n, e) => `float ${n} = ${e};`,
    letv2: (n, e) => `vec2 ${n} = ${e};`,
    varf: (n, e) => `float ${n} = ${e};`,
    varv4: (n, e) => `vec4 ${n} = ${e};`,
    declv4: (n) => `vec4 ${n};`,
    assign: (n, e) => `${n} = ${e};`,
    addTo: (n, e) => `${n} += ${e};`,
    loop: (v, n, body) => `for (int ${v} = 0; ${v} < ${n}; ${v}++) {\n${body}\n  }`,
    fi: (v) => `float(${v})`,
    sel: (c, t, f) => `((${c}) ? (${t}) : (${f}))`,
    brk: 'break;',
    pos: 'gl_FragCoord.xy',
    out: (e) => `fragColor = ${e};`,
    // gl_FragCoord and v_uv are both y-UP in GLSL.
    frag: (vx, vy) => `vec2(${vx}, ${vy})`,
  }
}

/** Insert the tap-counting texture wrapper and route every fetch through it. */
function instrumentFetches(src: string, kind: Kind, sampler: string): string {
  if (kind === 'wgsl') {
    const re = new RegExp(`textureSampleLevel\\(\\s*${sampler}_tex\\s*,\\s*${sampler}_samp\\s*,\\s*`, 'g')
    const n = (src.match(re) ?? []).length
    if (n === 0) throw new Error('instrumentFetches: no WGSL texture call found')
    const out = src.replace(re, 'sombra_fetch(')
    const helper = `
var<private> sombra_fetches: f32 = 0.0;
fn sombra_fetch(uv: vec2f, lod: f32) -> vec4f {
  sombra_fetches = sombra_fetches + 1.0;
  return textureSampleLevel(${sampler}_tex, ${sampler}_samp, uv, lod);
}
`
    const anchor = out.indexOf('struct VertexOutput')
    if (anchor < 0) throw new Error('instrumentFetches: WGSL VertexOutput anchor not found')
    return out.slice(0, anchor) + helper + '\n' + out.slice(anchor)
  }
  const re = new RegExp(`texture\\(\\s*${sampler}\\s*,\\s*`, 'g')
  const n = (src.match(re) ?? []).length
  if (n === 0) throw new Error('instrumentFetches: no GLSL texture call found')
  let out = src.replace(re, 'sombra_fetch(')
  const helper = `
float sombra_fetches = 0.0;
vec4 sombra_fetch(vec2 uv) {
  sombra_fetches += 1.0;
  return texture(${sampler}, uv);
}
`
  const anchor = out.indexOf(`uniform sampler2D ${sampler};`)
  if (anchor < 0) throw new Error('instrumentFetches: GLSL sampler declaration not found')
  const after = out.indexOf('\n', anchor) + 1
  out = out.slice(0, after) + helper + out.slice(after)
  // A GLSL ES global with a constant initialiser is per-invocation, but be
  // explicit: an implicitly-carried counter would report the sum over the draw.
  if (!GLSL_SIG.test(out)) throw new Error('instrumentFetches: GLSL main() not found for the counter reset')
  return out.replace(GLSL_SIG, (m) => `${m}\n  sombra_fetches = 0.0;`)
}

/**
 * Redirect a shader's FINAL fragment output to the encoded fetch count, keeping
 * the colour numerically live so no tap can be dead-code-eliminated.
 *
 * The compiler's own output line is not `return fo_col_out;` — fragment_output
 * premultiplies (`return vec4f(fo_col_out.rgb * fo_a_out, fo_a_out);`), so this
 * matches the LAST output statement in the module rather than a fixed string.
 * fs_main / main is emitted last, so "last" is the entry point's.
 */
function redirectOutputToCount(src: string, kind: Kind): string {
  const L = makeLang(kind)
  if (kind === 'wgsl') {
    const at = src.lastIndexOf('return ')
    if (at < 0) throw new Error('redirectOutputToCount: no WGSL return found')
    const end = src.indexOf(';', at)
    if (end < 0) throw new Error('redirectOutputToCount: unterminated WGSL return')
    const expr = src.slice(at + 'return '.length, end)
    return src.slice(0, at) + L.out(encodeCount(L, `(${expr})`)).replace(/;$/, '') + src.slice(end)
  }
  const at = src.lastIndexOf('fragColor = ')
  if (at < 0) throw new Error('redirectOutputToCount: no GLSL fragColor assignment found')
  const end = src.indexOf(';', at)
  if (end < 0) throw new Error('redirectOutputToCount: unterminated GLSL assignment')
  const expr = src.slice(at + 'fragColor = '.length, end)
  return src.slice(0, at) + L.out(encodeCount(L, `(${expr})`)).replace(/;$/, '') + src.slice(end)
}

/** 16-bit fetch count in R,G — the colour stays numerically live so the compiler
 *  cannot dead-code the taps away. */
function encodeCount(L: Lang, expr: string): string {
  if (L.kind === 'wgsl') {
    return `vec4f(f32(u32(sombra_fetches + 0.5) & 255u) / 255.0, f32((u32(sombra_fetches + 0.5) >> 8u) & 255u) / 255.0, (${expr}).r * 1e-7, 1.0)`
  }
  return `vec4(float(int(sombra_fetches + 0.5) & 255) / 255.0, float((int(sombra_fetches + 0.5) >> 8) & 255) / 255.0, (${expr}).r * 1e-7, 1.0)`
}

function decodeCount(img: Rgba8, margin: number): { mean: number; min: number; max: number } {
  let sum = 0
  let n = 0
  let mn = Infinity
  let mx = -Infinity
  for (let y = margin; y < img.height - margin; y++) {
    for (let x = margin; x < img.width - margin; x++) {
      const o = (y * img.width + x) * 4
      const c = img.data[o] + img.data[o + 1] * 256
      sum += c
      n++
      if (c < mn) mn = c
      if (c > mx) mx = c
    }
  }
  return n === 0 ? { mean: 0, min: 0, max: 0 } : { mean: sum / n, min: mn, max: mx }
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

/**
 * Emit a final-pass shader with:
 *   sombra_inner    — the SPLIT-DISABLED node body (1 clean bilinear tap)
 *   sombra_ship     — the untouched node body (split + frost arms intact)
 *   sombra_at/ship_at — either, evaluated at a fragCoord-space pixel offset
 *   sombra_uv       — the node's own rg_sampleUV at an offset (for the |L'| gate)
 *   fs_main         — the node's own geometry prologue, verbatim, then the candidate
 */
function assemble(sp: Split, kind: Kind, w: number, h: number, mainBody: string): string {
  const Wf = w.toFixed(1)
  const Hf = h.toFixed(1)
  const full = sp.bodyLines.join('\n')
  const noSplit = forceNoSplit(full)
  const head = sp.bodyLines.slice(0, sp.uvIdx).join('\n')
  const uvLine = sp.bodyLines[sp.uvIdx]
  const uvName = `rg_sampleUV_${sp.id}`

  if (kind === 'wgsl') {
    return `${sp.prelude}
fn sombra_inner(in: VertexOutput) -> vec4f {
${noSplit}
}

fn sombra_ship(in: VertexOutput) -> vec4f {
${full}
}

fn sombra_mk(base: VertexOutput, off: vec2f) -> VertexOutput {
  var s: VertexOutput;
  s.position = vec4f(base.position.x + off.x, base.position.y + off.y, base.position.z, base.position.w);
  // v_uv is y-UP while @builtin(position) is y-DOWN, so the y offset inverts.
  s.v_uv = vec2f(base.v_uv.x + off.x / ${Wf}, base.v_uv.y - off.y / ${Hf});
  return s;
}

fn sombra_at(base: VertexOutput, off: vec2f) -> vec4f { return sombra_inner(sombra_mk(base, off)); }
fn sombra_ship_at(base: VertexOutput, off: vec2f) -> vec4f { return sombra_ship(sombra_mk(base, off)); }

fn sombra_uv_i(in: VertexOutput) -> vec2f {
${head}
${uvLine}
  return ${uvName};
}
fn sombra_uv(base: VertexOutput, off: vec2f) -> vec2f { return sombra_uv_i(sombra_mk(base, off)); }

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
${head}
${mainBody}
}
`
  }
  return `${sp.prelude}
vec4 sombra_inner(vec4 sombraFC, vec2 sombraUV) {
${glslFnBody(noSplit.split('\n'))}
}

vec4 sombra_ship(vec4 sombraFC, vec2 sombraUV) {
${glslFnBody(sp.bodyLines)}
}

vec4 sombra_at(vec4 fc, vec2 uv, vec2 off) {
  // gl_FragCoord and v_uv are both y-UP in GLSL, so both offsets add.
  return sombra_inner(vec4(fc.x + off.x, fc.y + off.y, fc.z, fc.w), vec2(uv.x + off.x / ${Wf}, uv.y + off.y / ${Hf}));
}
vec4 sombra_ship_at(vec4 fc, vec2 uv, vec2 off) {
  return sombra_ship(vec4(fc.x + off.x, fc.y + off.y, fc.z, fc.w), vec2(uv.x + off.x / ${Wf}, uv.y + off.y / ${Hf}));
}

vec2 sombra_uv_i(vec4 sombraFC, vec2 sombraUV) {
${glslFnBody(sp.bodyLines.slice(0, sp.uvIdx + 1))}
  return ${uvName};
}
vec2 sombra_uv(vec4 fc, vec2 uv, vec2 off) {
  return sombra_uv_i(vec4(fc.x + off.x, fc.y + off.y, fc.z, fc.w), vec2(uv.x + off.x / ${Wf}, uv.y + off.y / ${Hf}));
}

void main() {
${head}
${mainBody}
}
`
}

// ===========================================================================
// Shared candidate preambles
// ===========================================================================

/**
 * The minification predicate, from the node's OWN rib phase and the closed form.
 *
 *   local = fract(rg_phi)              (rg_phi is the node's own rib phase)
 *   x     = 2*local - 1
 *   half footprint in x units = rg_hw [px] * rg_gl [periods/px] * 2 [x/period]
 *   |L'| is evaluated at BOTH footprint endpoints, because |L'| is V-shaped
 *   whenever A < 1 (it passes through zero at the magnifying fold), so the far
 *   edge alone is not the maximum.
 *
 * No hardware derivatives anywhere: `fwidth` is illegal under the possibly
 * non-uniform frost branch, mechanicalGlslToWgsl has no dFdx rule, and fwidth of
 * the folded coordinate returns the jump rather than the slope.
 */
function lprimePreamble(L: Lang, sp: Split): string {
  const id = sp.id
  const lines = [
    L.letf('sg_cv', sp.curvExpr),
    L.letf('sg_ir', sp.iorExpr),
    L.letf('sg_c', 'clamp(sg_cv, 0.01, 1.0)'),
    L.letf('sg_amp', L.sel('sg_cv > 1.0', 'sg_cv', '1.0')),
    L.letf('sg_k', 'min(sg_c, 0.99)'),
    L.letf('sg_A', '(sg_ir - 1.0) * sg_amp * sg_k'),
    L.letf('sg_lc', `fract(rg_phi_${id})`),
    L.letf('sg_x', 'sg_lc * 2.0 - 1.0'),
    L.letf('sg_hx', `rg_hw_${id} * rg_gl_${id} * 2.0`),
    L.letf('sg_x0', 'clamp(sg_x - sg_hx, -1.0, 1.0)'),
    L.letf('sg_x1', 'clamp(sg_x + sg_hx, -1.0, 1.0)'),
    L.letf('sg_d0', 'abs(1.0 - sg_A / pow(max(1.0 - sg_k * sg_k * sg_x0 * sg_x0, 1e-6), 1.5))'),
    L.letf('sg_d1', 'abs(1.0 - sg_A / pow(max(1.0 - sg_k * sg_k * sg_x1 * sg_x1, 1e-6), 1.5))'),
    L.letf('sg_lp', 'max(sg_d0, sg_d1)'),
  ]
  return lines.map((s) => '  ' + s).join('\n')
}

/** Unit seam normal / tangent as fragCoord-space offsets, and the pixel support. */
function axisPreamble(L: Lang, sp: Split): string {
  const id = sp.id
  const lines = [
    L.letv2('sg_n', L.frag(`rg_n_${id}.x`, `rg_n_${id}.y`)),
    L.letv2('sg_t', L.frag(`-rg_n_${id}.y`, `rg_n_${id}.x`)),
    L.letf('sg_hw', `rg_hw_${id}`),
  ]
  return lines.map((s) => '  ' + s).join('\n')
}

/** Uniform-in-screen midpoint quadrature of `k` taps over [-hw, +hw] on `axis`. */
function box1d(L: Lang, k: number, axis: string, jitter: boolean): string[] {
  const u = jitter ? 'sg_u' : '0.5'
  const pre = jitter
    ? [
      `  ${L.letv2('sg_r', `reedHash(floor(${L.pos}) + ${L.v2('0.5', '0.5')})`)}`,
      `  ${L.letf('sg_u', 'fract(sg_r.x * 0.5 + 0.5)')}`,
    ]
    : []
  const inner = [
    `    ${L.letf('sg_tt', `((${L.fi('sg_j')} + ${u}) / ${L.fnum(k)} - 0.5) * 2.0 * sg_hw`)}`,
    `    ${L.addTo('sg_acc', L.at(`${axis} * sg_tt`))}`,
  ].join('\n')
  return [
    ...pre,
    `  ${L.varv4('sg_acc', L.v4z)}`,
    '  ' + L.loop('sg_j', k, inner),
    `  ${L.assign('sg_col', `sg_acc * ${L.fnum(1 / k)}`)}`,
  ]
}

/**
 * Trapezoid-weighted 1-D box — the EXACT projection of the unit pixel square
 * onto the seam normal, rather than a box over the same support. The projection
 * of a unit square onto a direction n is box(|nx|) * box(|ny|): a trapezoid of
 * total support |nx|+|ny| = 2*hw with a plateau of ||nx|-|ny||, i.e. the ramp
 * width is min(|nx|,|ny|). The current code (and box1d above) uses a box over
 * that support, which over-weights the corners.
 */
function box1dTrapezoid(L: Lang, k: number, sp: Split): string[] {
  const id = sp.id
  const inner = [
    `    ${L.letf('sg_tt', `((${L.fi('sg_j')} + 0.5) / ${L.fnum(k)} - 0.5) * 2.0 * sg_hw`)}`,
    `    ${L.letf('sg_wt', 'clamp((sg_hw - abs(sg_tt)) / max(sg_ramp, 1e-6), 0.0, 1.0)')}`,
    `    ${L.addTo('sg_acc', `${L.at('sg_n * sg_tt')} * sg_wt`)}`,
    `    ${L.addTo('sg_w', 'sg_wt')}`,
  ].join('\n')
  return [
    `  ${L.letf('sg_ramp', `min(abs(rg_n_${id}.x), abs(rg_n_${id}.y))`)}`,
    `  ${L.varv4('sg_acc', L.v4z)}`,
    `  ${L.varf('sg_w', '0.0')}`,
    '  ' + L.loop('sg_j', k, inner),
    `  ${L.assign('sg_col', 'sg_acc / max(sg_w, 1e-5)')}`,
  ]
}

/**
 * Adaptive N with trapezoid weights — the combination the sweep's first pass
 * pointed at: the trapezoid (not the missing tangential dimension) was what the
 * plain box's residual floor was made of, and the adaptive count is what makes it
 * affordable. Literal loop bound + early break, as GLSL ES 3.00 requires.
 */
function box1dTrapezoidAdaptive(L: Lang, nmax: number, sp: Split, floor4 = false): string[] {
  const id = sp.id
  const inner = [
    `    if (${L.fi('sg_j')} >= sg_nn) ${L.brk}`,
    `    ${L.letf('sg_tt', '((' + L.fi('sg_j') + ' + 0.5) / sg_nn - 0.5) * 2.0 * sg_hw')}`,
    `    ${L.letf('sg_wt', 'clamp((sg_hw - abs(sg_tt)) / max(sg_ramp, 1e-6), 0.0, 1.0)')}`,
    `    ${L.addTo('sg_acc', `${L.at('sg_n * sg_tt')} * sg_wt`)}`,
    `    ${L.addTo('sg_w', 'sg_wt')}`,
  ].join('\n')
  return [
    `  ${L.letf('sg_ramp', `min(abs(rg_n_${id}.x), abs(rg_n_${id}.y))`)}`,
    // N=2 is MEASURED WORSE THAN N=1 (userLowCurv/hicon: every ceil(|L'|) variant
    // read 6.7615 vs the 1-tap control's 6.4213, identical to fixed N=2, because
    // sup|L'| = 1.407 there so ceil() picks 2 everywhere the gate fires). Two taps
    // at +-hw/2 straddle a footprint barely wider than one pixel and miss its
    // centre; the trapezoid does not rescue it, because at |t| = hw/2 both weights
    // still clamp to 1. Flooring the ladder at 4 removes that rung: fixed N=4 reads
    // 6.1548 there, i.e. better than the control.
    `  ${L.letf('sg_nn', floor4
      ? `clamp(max(ceil(sg_lp), 4.0), 1.0, ${L.fnum(nmax)})`
      : `clamp(ceil(sg_lp), 1.0, ${L.fnum(nmax)})`)}`,
    `  ${L.varv4('sg_acc', L.v4z)}`,
    `  ${L.varf('sg_w', '0.0')}`,
    '  ' + L.loop('sg_j', nmax, inner),
    `  ${L.assign('sg_col', 'sg_acc / max(sg_w, 1e-5)')}`,
  ]
}

/**
 * kn taps along the seam normal x kt along the seam tangent — the experiment that
 * decides whether the 1-D residual floor is the UNFILTERED TANGENTIAL direction
 * or something else. If kn x 2 drops to the 2-D GT's level while kn x 1 floors,
 * 1-D is insufficient; if it floors at the same value, the residual is not
 * tangential.
 *
 * NOTE the support: a square of half-side hw in the rotated frame CIRCUMSCRIBES
 * the unit pixel (exact only when the normal is axis-aligned; 22% over-area at
 * the user's 12.3 deg tilt), so this diagnostic errs toward slight over-blur. It
 * is a diagnostic, not a ship candidate.
 */
function box2d(L: Lang, kn: number, kt: number): string[] {
  const inner = [
    `      ${L.letf('sg_tn', `((${L.fi('sg_j')} + 0.5) / ${L.fnum(kn)} - 0.5) * 2.0 * sg_hw`)}`,
    `      ${L.letf('sg_tg', `((${L.fi('sg_i2')} + 0.5) / ${L.fnum(kt)} - 0.5) * 2.0 * sg_hw`)}`,
    `      ${L.addTo('sg_acc', L.at('sg_n * sg_tn + sg_t * sg_tg'))}`,
  ].join('\n')
  return [
    `  ${L.varv4('sg_acc', L.v4z)}`,
    '  ' + L.loop('sg_i2', kt, '  ' + L.loop('sg_j', kn, inner)),
    `  ${L.assign('sg_col', `sg_acc * ${L.fnum(1 / (kn * kt))}`)}`,
  ]
}

/** Adaptive N with a literal loop bound and an early break — the blur.ts pattern,
 *  which is the only form GLSL ES 3.00 accepts for a runtime tap count. */
function box1dAdaptive(L: Lang, nmax: number, axis: string, jitter: boolean): string[] {
  const u = jitter ? 'sg_u' : '0.5'
  const pre = jitter
    ? [
      `  ${L.letv2('sg_r', `reedHash(floor(${L.pos}) + ${L.v2('0.5', '0.5')})`)}`,
      `  ${L.letf('sg_u', 'fract(sg_r.x * 0.5 + 0.5)')}`,
    ]
    : []
  const inner = [
    `    if (${L.fi('sg_j')} >= sg_nn) ${L.brk}`,
    `    ${L.letf('sg_tt', `((${L.fi('sg_j')} + ${u}) / sg_nn - 0.5) * 2.0 * sg_hw`)}`,
    `    ${L.addTo('sg_acc', L.at(`${axis} * sg_tt`))}`,
    `    ${L.addTo('sg_w', '1.0')}`,
  ].join('\n')
  return [
    ...pre,
    `  ${L.letf('sg_nn', `clamp(ceil(sg_lp), 1.0, ${L.fnum(nmax)})`)}`,
    `  ${L.varv4('sg_acc', L.v4z)}`,
    `  ${L.varf('sg_w', '0.0')}`,
    '  ' + L.loop('sg_j', nmax, inner),
    `  ${L.assign('sg_col', 'sg_acc / max(sg_w, 1e-5)')}`,
  ]
}

/**
 * Uniform in the SOURCE pre-image instead of in screen space, for the M1 design
 * question. Kept only to DEMONSTRATE that it is the wrong integral: it computes
 * (1/|U|)*integral I(u) du, which equals the box filter over the screen pixel
 * only if the map is affine across the footprint, and it has no 1/|L'| weight and
 * no sum over monotone branches. At the node defaults L' changes sign inside the
 * rib, so the two endpoints do not even bracket the sampled set.
 *
 * Implemented by taking the two endpoint sample positions the node itself
 * produces (`sombra_uv` at +-hw along the normal) and lerping between them in
 * SOURCE UV — the closest thing to "uniform in the pre-image" that needs no
 * inverse map. Every tap is a raw fetch at a lerped source position.
 */
function box1dSourceUniform(L: Lang, k: number): string[] {
  const fetch = (uv: string) => (L.kind === 'wgsl'
    ? `sombra_tapuv(${uv})`
    : `sombra_tapuv(${uv})`)
  const inner = [
    `    ${L.letf('sg_a', `(${L.fi('sg_j')} + 0.5) / ${L.fnum(k)}`)}`,
    `    ${L.addTo('sg_acc', fetch('mix(sg_u0, sg_u1, sg_a)'))}`,
  ].join('\n')
  return [
    `  ${L.letv2('sg_u0', L.kind === 'wgsl' ? 'sombra_uv(in, sg_n * (-sg_hw))' : 'sombra_uv(gl_FragCoord, v_uv, sg_n * (-sg_hw))')}`,
    `  ${L.letv2('sg_u1', L.kind === 'wgsl' ? 'sombra_uv(in, sg_n * ( sg_hw))' : 'sombra_uv(gl_FragCoord, v_uv, sg_n * ( sg_hw))')}`,
    `  ${L.varv4('sg_acc', L.v4z)}`,
    '  ' + L.loop('sg_j', k, inner),
    `  ${L.assign('sg_col', `sg_acc * ${L.fnum(1 / k)}`)}`,
  ]
}

/** Raw fetch helper, appended when a candidate samples a source UV directly. */
function tapUvHelper(kind: Kind, sampler: string): string {
  if (kind === 'wgsl') {
    return `
fn sombra_tapuv(uv: vec2f) -> vec4f {
  var t = uv;
  t = vec2f(1.0) - abs(fract(t * 0.5) * vec2f(2.0) - vec2f(1.0));
  return textureSampleLevel(${sampler}_tex, ${sampler}_samp, t, 0.0);
}
`
  }
  return `
vec4 sombra_tapuv(vec2 uv) {
  vec2 t = uv;
  t = 1.0 - abs(fract(t * 0.5) * 2.0 - 1.0);
  return texture(${sampler}, t);
}
`
}

const RGSS4: Array<[number, number]> = [[-0.125, -0.375], [0.375, -0.125], [-0.375, 0.125], [0.125, 0.375]]

/** Offset used by the E1 extrapolation probe, device px along the seam normal.
 *  0.5 px is the largest offset a 1-px footprint ever asks for. */
const E1_OFFSET_PX = 0.5

// ===========================================================================
// Candidates
// ===========================================================================

interface CandCtx { sampler: string; ior: number; curvature: number }

interface Candidate {
  id: string
  family: 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7'
  label: string
  /** taps the design intends at its worst; the real count is MEASURED */
  nominalFetches: number
  /** true when the shader is used completely untouched */
  raw?: boolean
  /** patch the emitted text before any surgery (M3, M5) */
  patch?: (src: string, kind: Kind, ctx: CandCtx) => string
  /** candidate body; `sg_col` must be assigned */
  body?: (L: Lang, sp: Split, ctx: CandCtx) => string[]
  /** needs the raw-UV fetch helper */
  needsTapUv?: boolean
  /** box-grid GT: N x N over the pixel, tile (tx,ty) of a T x T decomposition */
  grid?: { n: number }
  /** true when the candidate is UNCONDITIONAL and therefore cannot be a no-op */
  unconditional?: boolean
  /** diagnostic probe, deliberately not a no-op — excluded from the V6 guard */
  probe?: boolean
  notes?: string
}

/** Wrap a candidate body in the `sg_lp > 1` gate, falling back to the untouched
 *  shipped shader — the construction that makes the defaults no-op a proof. */
function gated(L: Lang, inner: string[]): string[] {
  return [
    `  ${L.declv4('sg_col')}`,
    '  if (sg_lp > 1.0) {',
    ...inner,
    '  } else {',
    `  ${L.assign('sg_col', L.ship(L.v2('0.0', '0.0')))}`,
    '  }',
  ]
}

const CANDIDATES: Candidate[] = [
  {
    id: 'M0', family: 'M0', label: 'control — what ships at aa082c0 (1 tap + seam-coverage split)',
    nominalFetches: 1, raw: true,
  },
  {
    id: 'M0-nosplit', family: 'M0', label: 'control — split forced off (phase 12: byte-identical to pre-AA)',
    nominalFetches: 1,
    body: (L) => [`  ${L.varv4('sg_col', L.at(L.v2('0.0', '0.0')))}`],
    notes: 'the canonical GT base; also the wrapper-inertness reference',
  },
  {
    id: 'M0-wrap', family: 'M0', label: 'wrapper-inertness control — shipped body at zero offset',
    nominalFetches: 1,
    body: (L) => [`  ${L.varv4('sg_col', L.ship(L.v2('0.0', '0.0')))}`],
    notes: 'MUST be byte-identical to M0; proves the source surgery is inert',
  },

  // --- M1: analytic adaptive 1-D supersampling, uniform in SCREEN space --------
  ...[2, 4, 8, 16].map((k): Candidate => ({
    id: `M1-N${k}`, family: 'M1',
    label: `1-D box along the seam normal, uniform in SCREEN, fixed N=${k}, gated on |L'|>1`,
    nominalFetches: k,
    body: (L) => gated(L, box1d(L, k, 'sg_n', false)),
  })),
  ...[4, 8, 16].map((k): Candidate => ({
    id: `M1-adapt${k}`, family: 'M1',
    label: `adaptive N = clamp(ceil(|L'|),1,${k}) along the seam normal, uniform in SCREEN`,
    nominalFetches: k,
    body: (L) => gated(L, box1dAdaptive(L, k, 'sg_n', false)),
    notes: 'literal loop bound + early break (the src/nodes/effect/blur.ts pattern)',
  })),
  // The 1-D ASYMPTOTE. Not ship candidates — they answer "does 1-D along the
  // normal converge to the 2-D box, or does it floor?"
  ...[32, 64].map((k): Candidate => ({
    id: `M1-N${k}`, family: 'M1',
    label: `1-D box along the seam normal, N=${k} — measures the 1-D ASYMPTOTE (diagnostic)`,
    nominalFetches: k,
    body: (L) => gated(L, box1d(L, k, 'sg_n', false)),
    notes: 'diagnostic: too expensive to ship, run to find where the 1-D estimator stops improving',
  })),
  // Trapezoid weights — the EXACT pixel-square projection instead of a box.
  ...[8, 16].map((k): Candidate => ({
    id: `M1-N${k}w`, family: 'M1',
    label: `1-D trapezoid-weighted (exact pixel-square projection onto the normal), N=${k}`,
    nominalFetches: k,
    body: (L, sp) => gated(L, box1dTrapezoid(L, k, sp)),
  })),
  // Adaptive N x trapezoid weights — the two findings of the first sweep pass
  // combined. This is the candidate the ranking actually recommends.
  ...[8, 16, 32].map((k): Candidate => ({
    id: `M1-adapt${k}w`, family: 'M1',
    label: `adaptive N = clamp(ceil(|L'|),1,${k}) with TRAPEZOID weights (exact pixel-square projection)`,
    nominalFetches: k,
    body: (L, sp) => gated(L, box1dTrapezoidAdaptive(L, k, sp)),
    notes: 'literal loop bound + early break (the src/nodes/effect/blur.ts pattern)',
  })),
  // The RECOMMENDED shape: adaptive N x trapezoid weights, ladder floored at 4 so
  // the measured-bad N=2 rung is unreachable. `N = 1` (the gate false) or `N >= 4`.
  ...[16, 32].map((k): Candidate => ({
    id: `M1-adapt${k}wF`, family: 'M1',
    label: `adaptive N = clamp(max(ceil(|L'|),4),1,${k}), TRAPEZOID weights — the recommended shape ` +
      '(ladder floored at 4 because N=2 measured worse than N=1)',
    nominalFetches: k,
    body: (L, sp) => gated(L, box1dTrapezoidAdaptive(L, k, sp, true)),
    notes: 'literal loop bound + early break (the src/nodes/effect/blur.ts pattern)',
  })),
  // The 2-D control: does adding the TANGENTIAL direction break the 1-D floor?
  ...[8, 16].map((kn): Candidate => ({
    id: `M1-N${kn}x2`, family: 'M1',
    label: `${kn} taps along the normal x 2 along the tangent — the 1-D-sufficiency experiment`,
    nominalFetches: kn * 2,
    body: (L) => gated(L, box2d(L, kn, 2)),
    notes: 'circumscribing support: 22% over-area at the user\'s 12.3 deg seam tilt, so it errs toward over-blur',
  })),
  ...[4, 16].map((k): Candidate => ({
    id: `M1-src${k}`, family: 'M1',
    label: `uniform in the SOURCE pre-image, N=${k} — the wrong integral, benched to show it`,
    nominalFetches: k, needsTapUv: true,
    body: (L) => gated(L, box1dSourceUniform(L, k)),
    notes: 'no 1/|L\'| weight, no branch sum; endpoints do not bracket the set once L\' changes sign',
  })),

  // --- M2: unconditional 2x2 rotated grid (the prior study's A3) ---------------
  {
    id: 'M2', family: 'M2', label: '2x2 rotated-grid supersample (RGSS), UNCONDITIONAL',
    nominalFetches: 4, unconditional: true,
    body: (L) => {
      const terms = RGSS4.map(([x, y]) => L.at(L.v2(L.fnum(x), L.fnum(y))))
      return [`  ${L.varv4('sg_col', `(${terms.join('\n    + ')}) * ${L.fnum(0.25)}`)}`]
    },
    notes: 'cannot be a no-op at the defaults by construction — reported, not hidden',
  },
  {
    id: 'M2g', family: 'M2', label: "2x2 RGSS gated on |L'|>1",
    nominalFetches: 4,
    body: (L) => gated(L, [
      `  ${L.assign('sg_col', `(${RGSS4.map(([x, y]) => L.at(L.v2(L.fnum(x), L.fnum(y)))).join('\n    + ')}) * ${L.fnum(0.25)}`)}`,
    ]),
  },

  // --- M3: slope clamp — the LOOK-CHANGING control -----------------------------
  ...[1, 4, 16].map((C): Candidate => ({
    id: `M3-C${C}`, family: 'M3',
    label: `slope clamp, TARGET |L'| <= ${C} (CHANGES THE LOOK; the target is only REACHABLE where ` +
      "C < A/sqrt(1-k^2) - 1, else the patch is inert — see the reachability table)",
    nominalFetches: 1, raw: true,
    patch: (src, kind, ctx) => patchSlopeClamp(src, kind, slopeClampEps(ctx.ior, ctx.curvature, C)),
    notes: 'known-bad for the look metric; the cheap alternative, honestly labelled',
  })),

  // --- M4: stochastic / jittered 1-D ------------------------------------------
  ...[4, 8].map((k): Candidate => ({
    id: `M4-N${k}`, family: 'M4', label: `jittered stratified 1-D along the seam normal, N=${k}`,
    nominalFetches: k,
    body: (L) => gated(L, box1d(L, k, 'sg_n', true)),
    notes: 'per-device-pixel Cranley-Patterson rotation via the node\'s own reedHash; no TAA exists to hide the grain',
  })),
  {
    id: 'M4-adapt8', family: 'M4', label: "jittered adaptive N = clamp(ceil(|L'|),1,8)",
    nominalFetches: 8,
    body: (L) => gated(L, box1dAdaptive(L, 8, 'sg_n', true)),
  },

  // --- M5: naive analytic prefilter — REFUTED, kept as a known-bad -------------
  {
    id: 'M5', family: 'M5', label: 'coordinate taper (smoothFract family) — refuted; kept as known-bad',
    nominalFetches: 1, raw: true, unconditional: true,
    patch: (src, kind) => patchTaper(src, kind),
    notes: 'averaging the sampled POSITION equals averaging the COLOUR only if the source is locally affine across a 52-289 px jump; it is not',
  },

  // --- M6: ground truth --------------------------------------------------------
  ...[8, 16, 32, 64].map((n): Candidate => ({
    id: `M6-GT${n}`, family: 'M6', label: `GROUND TRUTH — ${n}x${n} box supersample of the split-disabled body`,
    nominalFetches: n * n, grid: { n },
  })),

  // --- E1 pair: isolate the phase-extrapolation emulation gap -----------------
  // Not candidates. `E1-extrap` forces the node's OWN sub-sample machinery to a
  // FIXED offset (rg_ca := d, rg_split := true, rg_wa := 1) so its output is
  // exactly the node's first-order-extrapolated tap at +d px along the seam
  // normal. `E1-reeval` takes the same tap through the wrapper, which
  // re-evaluates the rib field there. The difference is E1 and nothing else.
  {
    id: 'E1-extrap', family: 'M0', label: `probe: the NODE's extrapolated tap at +${E1_OFFSET_PX} px on the seam normal`,
    nominalFetches: 1, raw: true, probe: true,
    patch: (src, kind) => patchFixedSubsample(src, kind, E1_OFFSET_PX),
  },
  {
    id: 'E1-reeval', family: 'M0', label: `probe: the same tap with the rib field RE-EVALUATED there`,
    nominalFetches: 1, probe: true,
    body: (L) => [`  ${L.varv4('sg_col', L.at(`sg_n * ${L.fnum(E1_OFFSET_PX)}`))}`],
  },

  // --- M7: tangential-only 1-px filter ----------------------------------------
  ...[2, 3].map((k): Candidate => ({
    id: `M7-N${k}`, family: 'M7', label: `tangential-only (ALONG the seam) 1-px box, N=${k}, gated`,
    nominalFetches: k,
    body: (L) => gated(L, box1d(L, k, 'sg_t', false)),
    notes: 'filters the staircase direction and leaves cross-rib contrast alone',
  })),
]
const CAND_BY_ID: Record<string, Candidate> = Object.fromEntries(CANDIDATES.map((c) => [c.id, c]))

// ===========================================================================
// Source patches (M3, M5)
// ===========================================================================

/**
 * M3 — cap |L'| at C by raising the floor inside the node's own
 * `sqrt(max(1.0 - x2, 0.001))`. Wherever `1 - k^2 x^2 < eps` the slope becomes
 * linear in x, so d(disp)/d(local) is exactly -A/sqrt(eps); eps = (A/(1+C))^2
 * makes that -(1+C), i.e. L' = -C. The profile is untouched wherever it was
 * already under the cap.
 */
function patchSlopeClamp(src: string, kind: Kind, eps: number): string {
  const re = kind === 'wgsl'
    ? /(var|let)\s+slope\s*:\s*f32\s*=\s*x \* c2 \/ sqrt\(max\(1\.0 - x2, 0\.001\)\);/
    : /float slope = x \* c2 \/ sqrt\(max\(1\.0 - x2, 0\.001\)\);/
  const n = (src.match(new RegExp(re.source, 'g')) ?? []).length
  if (n !== 1) throw new Error(`M3: expected 1 slope line in ${kind}, found ${n}`)
  const lit = eps.toPrecision(9)
  return src.replace(re, (m) => m.replace('0.001', lit))
}

/**
 * E1 probe — pin the node's own `_a` sub-sample to a FIXED offset and force the
 * split arm to output it alone. Three one-token edits to the node's own emitted
 * lines, each asserted to apply exactly once:
 *   rg_ca_*    := the fixed offset in device px
 *   rg_split_* := true          (take the split arm)
 *   rg_wa_*    := 1.0           (weight the `_a` tap fully)
 * Everything else — the first-order phase extrapolation in `rg_swm_a_*`, the
 * shared rib gradient, the delta transform — is the node's, untouched.
 */
function patchFixedSubsample(src: string, kind: Kind, offPx: number): string {
  const lit = offPx.toPrecision(6)
  const subs: Array<[RegExp, string, string]> = kind === 'wgsl'
    ? [
      [/(var rg_ca_\w+: f32 = )\([^;]*;/, `$1${lit};`, 'rg_ca'],
      [/(var rg_split_\w+: bool = )abs\([^;]*;/, '$1true;', 'rg_split'],
      [/(var rg_wa_\w+: f32 = )\([^;]*;/, '$11.0;', 'rg_wa'],
    ]
    : [
      [/(float rg_ca_\w+ = )\([^;]*;/, `$1${lit};`, 'rg_ca'],
      [/(bool rg_split_\w+ = )abs\([^;]*;/, '$1true;', 'rg_split'],
      [/(float rg_wa_\w+ = )\([^;]*;/, '$11.0;', 'rg_wa'],
    ]
  let out = src
  for (const [re, to, name] of subs) {
    const n = (out.match(new RegExp(re.source, 'g')) ?? []).length
    if (n !== 1) throw new Error(`E1: expected 1 ${name} line in ${kind}, found ${n}`)
    out = out.replace(re, to)
  }
  return out
}

/**
 * M5 — the naive analytic prefilter: fade the refraction displacement to zero
 * within a fraction of a rib of each seam, so the *coordinate* is smooth. Adds a
 * 5th `taperLocal` parameter to the node's own reedLens and threads it at the
 * SCREEN call sites only; the frozen-ref call (which drives the `coords` output)
 * gets 0 so the node's other output is unchanged.
 */
const TAPER_LOCAL = 0.02
function patchTaper(src: string, kind: Kind): string {
  const sigRe = kind === 'wgsl'
    ? /fn reedLens\(coord: f32, ribW: f32, ior: f32, curvature: f32\) -> vec2f \{/
    : /vec2 reedLens\(float coord, float ribW, float ior, float curvature\) \{/
  if (!sigRe.test(src)) throw new Error(`M5: reedLens signature not found in ${kind}`)
  let out = src.replace(sigRe, kind === 'wgsl'
    ? 'fn reedLens(coord: f32, ribW: f32, ior: f32, curvature: f32, taperLocal: f32) -> vec2f {'
    : 'vec2 reedLens(float coord, float ribW, float ior, float curvature, float taperLocal) {')

  const dispRe = kind === 'wgsl'
    ? /((?:var|let)\s+disp\s*:\s*f32\s*=\s*-slope \* \(ior - 1\.0\) \* 0\.5 \* amp;)/
    : /(float disp = -slope \* \(ior - 1\.0\) \* 0\.5 \* amp;)/
  if (!dispRe.test(out)) throw new Error(`M5: disp line not found in ${kind}`)
  out = out.replace(dispRe, `$1\n  disp = disp * smoothstep(0.0, max(taperLocal, 1e-6), min(local, 1.0 - local));`)

  let screen = 0
  let ref = 0
  out = out.split('\n').map((line) => {
    if (!line.includes('reedLens(')) return line
    if (/reedLens\(\s*rg_swm/.test(line)) { screen++; return line.replace(/\)\s*;\s*$/, `, ${TAPER_LOCAL.toPrecision(6)});`) }
    if (/reedLens\(\s*rg_wm_(?!scr)/.test(line)) { ref++; return line.replace(/\)\s*;\s*$/, ', 0.0);') }
    return line
  }).join('\n')
  if (screen !== 3 || ref !== 1) {
    throw new Error(`M5: expected 3 screen + 1 ref reedLens call sites in ${kind}, patched ${screen} + ${ref}`)
  }
  return out
}

// ===========================================================================
// Pass construction
// ===========================================================================

type Mode = 'color' | 'count'

interface GridTile { n: number; t: number; tx: number; ty: number }

function boxGridBody(L: Lang, g: GridTile): string[] {
  const n = g.n / g.t
  const inner = [
    `      ${L.letf('sg_gx', `${L.fi('sg_x')} + ${L.fnum(g.tx * n)}`)}`,
    `      ${L.letf('sg_gy', `${L.fi('sg_y')} + ${L.fnum(g.ty * n)}`)}`,
    `      ${L.letf('sg_ox', `(sg_gx + 0.5) / ${L.fnum(g.n)} - 0.5`)}`,
    `      ${L.letf('sg_oy', `(sg_gy + 0.5) / ${L.fnum(g.n)} - 0.5`)}`,
    `      ${L.addTo('sg_acc', L.at(L.v2('sg_ox', 'sg_oy')))}`,
  ].join('\n')
  return [
    `  ${L.varv4('sg_acc', L.v4z)}`,
    '  ' + L.loop('sg_y', n, '  ' + L.loop('sg_x', n, inner)),
    `  ${L.varv4('sg_col', `sg_acc * ${L.fnum(1 / (n * n))}`)}`,
  ]
}

function candidatePasses(
  g: BuiltGraph, cand: Candidate, ctx: CandCtx, mode: Mode, tile?: GridTile,
): AaPass[] {
  const passes = g.passes.map((p) => ({ ...p }))
  const last = passes[passes.length - 1]

  const make = (kind: Kind, src0: string): string => {
    let src = src0
    if (cand.patch) src = cand.patch(src, kind, ctx)
    if (!cand.raw) {
      const L = makeLang(kind)
      const sp = splitShader(src, kind)
      let body: string[]
      if (cand.grid) {
        body = boxGridBody(L, tile ?? { n: cand.grid.n, t: 1, tx: 0, ty: 0 })
      } else if (cand.body) {
        body = cand.body(L, sp, ctx)
      } else {
        throw new Error(`candidate ${cand.id} has neither body, grid nor raw`)
      }
      const pre = [axisPreamble(L, sp), lprimePreamble(L, sp)].join('\n')
      src = assemble(sp, kind, W, H, [pre, ...body, `  ${L.out('sg_col')}`].join('\n'))
      if (cand.needsTapUv) {
        const anchor = kind === 'wgsl' ? src.indexOf('fn sombra_inner') : src.indexOf('vec4 sombra_inner')
        if (anchor < 0) throw new Error('tapUvHelper: anchor not found')
        src = src.slice(0, anchor) + tapUvHelper(kind, ctx.sampler) + '\n' + src.slice(anchor)
      }
    }
    if (mode === 'count') {
      src = redirectOutputToCount(src, kind)
      src = instrumentFetches(src, kind, ctx.sampler)
    }
    return src
  }

  last.wgsl = make('wgsl', last.wgsl)
  last.glslFrag = make('glsl', last.glslFrag)
  return passes
}

/** A pass returning the signed seam distance and normal, from the node's OWN
 *  `rg_ss_*` / `rg_n_*` — for `lib/edge-metrics.staircase`. */
const SEAM_RANGE_PX = 24
function seamProbePasses(g: BuiltGraph): AaPass[] {
  const passes = g.passes.map((p) => ({ ...p }))
  const last = passes[passes.length - 1]
  const build = (kind: Kind, src: string): string => {
    const L = makeLang(kind)
    const sp = splitShader(src, kind)
    const body = [
      `  ${L.letf('sg_v', `clamp(rg_ss_${sp.id} / ${L.fnum(2 * SEAM_RANGE_PX)} + 0.5, 0.0, 1.0)`)}`,
      `  ${L.out(kind === 'wgsl'
        ? `vec4f(sg_v, rg_n_${sp.id}.x * 0.5 + 0.5, rg_n_${sp.id}.y * 0.5 + 0.5, 1.0)`
        : `vec4(sg_v, rg_n_${sp.id}.x * 0.5 + 0.5, rg_n_${sp.id}.y * 0.5 + 0.5, 1.0)`)}`,
    ].join('\n')
    return assemble(sp, kind, W, H, body)
  }
  last.wgsl = build('wgsl', last.wgsl)
  last.glslFrag = build('glsl', last.glslFrag)
  return passes
}

/**
 * 16-bit encode of a [0,1] value into R,G — an 8-bit ratio channel cannot resolve
 * a 1%-agreement gate, and the first version of this probe was quantisation-bound.
 */
function enc16(L: Lang, v: string): string {
  const four = L.kind === 'wgsl' ? 'vec4f' : 'vec4'
  return `${four}(floor(floor(clamp(${v}, 0.0, 1.0) * 65535.0 + 0.5) / 256.0) / 255.0, ` +
    `(floor(clamp(${v}, 0.0, 1.0) * 65535.0 + 0.5) - floor(floor(clamp(${v}, 0.0, 1.0) * 65535.0 + 0.5) / 256.0) * 256.0) / 255.0, ` +
    `SG_VALID, 1.0)`
}

function dec16(img: Rgba8, i: number, scale: number): { v: number; valid: boolean } {
  const o = i * 4
  return { v: ((img.data[o] * 256 + img.data[o + 1]) / 65535) * scale, valid: img.data[o + 2] > 127 }
}

type ProbeWhich = 'rib' | 'full'

/**
 * Two independent validations of the closed-form predicate against the map the
 * node ACTUALLY emits. They measure different things and the first version of
 * this gate conflated them, which is why it failed:
 *
 *  'rib'  — |L'| at the pixel CENTRE, closed form, against a central difference
 *           of the node's OWN `reedLens` cross-rib map, differenced in rib-phase
 *           units. This is the gate that says the closed form is right. Ratio
 *           must be ~1.000. Invalid where a seam or a mirror-fold vertex falls
 *           inside the +-0.02 px step, or where |L'| < 0.05 (the fold makes the
 *           ratio ill-conditioned) — both rejections are made on the ANALYTIC
 *           side, never on the measured result.
 *
 *  'full'  — the predicate `sg_lp` (max |L'| over the pixel footprint) against
 *           the measured FULL screen-space stretch of the seam normal,
 *           |d(rg_sampleUV)/dt| * resolution. These are NOT equal: the closed
 *           form is the main-axis component only, while the real Jacobian also
 *           carries the bow shear. Reported as a finding, not asserted equal.
 */
function lprimeProbePasses(g: BuiltGraph, which: ProbeWhich): AaPass[] {
  const passes = g.passes.map((p) => ({ ...p }))
  const last = passes[passes.length - 1]
  const build = (kind: Kind, src: string): string => {
    const L = makeLang(kind)
    const sp = splitShader(src, kind)
    const id = sp.id
    const uv = (o: string) => (kind === 'wgsl' ? `sombra_uv(in, ${o})` : `sombra_uv(gl_FragCoord, v_uv, ${o})`)
    const res = kind === 'wgsl' ? 'uniforms.u_resolution' : 'u_resolution'
    const rib = `rg_ribUV_scr_${id}`
    const common = [axisPreamble(L, sp), lprimePreamble(L, sp)]
    let body: string
    if (which === 'rib') {
      body = [
        ...common,
        `  ${L.letf('sg_lp0', 'abs(1.0 - sg_A / pow(max(1.0 - sg_k * sg_k * sg_x * sg_x, 1e-6), 1.5))')}`,
        `  ${L.letf('sg_e', '0.02')}`,
        `  ${L.letf('sg_wa', `rg_wm_scr_${id} + (-sg_e) * rg_gl_${id} * ${rib}`)}`,
        `  ${L.letf('sg_wb', `rg_wm_scr_${id} + ( sg_e) * rg_gl_${id} * ${rib}`)}`,
        `  ${L.letf('sg_la', `reedLens(sg_wa, ${rib}, sg_ir, sg_cv).x`)}`,
        `  ${L.letf('sg_lb', `reedLens(sg_wb, ${rib}, sg_ir, sg_cv).x`)}`,
        `  ${L.letf('sg_dl', `(sg_lb - sg_la) / ${rib}`)}`,
        `  ${L.letf('sg_dp', `(sg_wb - sg_wa) / ${rib}`)}`,
        `  ${L.letf('sg_meas', 'abs(sg_dl) / max(abs(sg_dp), 1e-12)')}`,
        `  ${L.letf('SG_VALID', L.sel(`abs(rg_ss_${id}) > 1.0 && sg_lp0 > 0.05 && sg_meas < 2.0 * sg_lp0`, '1.0', '0.0'))}`,
        `  ${L.out(enc16(L, 'sg_meas / max(sg_lp0, 1e-6) * 0.5'))}`,
      ].join('\n')
    } else {
      body = [
        ...common,
        `  ${L.letf('sg_e', '0.05')}`,
        `  ${L.letv2('sg_ua', uv('sg_n * (-sg_e)'))}`,
        `  ${L.letv2('sg_ub', uv('sg_n * ( sg_e)'))}`,
        `  ${L.letv2('sg_du', `(sg_ub - sg_ua) * ${res}`)}`,
        `  ${L.letf('sg_meas', 'length(sg_du) / (2.0 * sg_e)')}`,
        `  ${L.letf('SG_VALID', L.sel(`sg_lp > 1.0 && abs(rg_ss_${id}) > 1.0`, '1.0', '0.0'))}`,
        `  ${L.out(enc16(L, 'sg_meas / max(sg_lp, 1e-6) * 0.25'))}`,
      ].join('\n')
    }
    return assemble(sp, kind, W, H, body)
  }
  last.wgsl = build('wgsl', last.wgsl)
  last.glslFrag = build('glsl', last.glslFrag)
  return passes
}

/**
 * The predicate `sg_lp` itself, per pixel, log-encoded — so the sweep's error can
 * be STRATIFIED by local minification instead of averaged across a rib whose
 * |L'| spans 0.4 to 200. This is what answers "what tap count is needed at
 * |L'| = 175.9" with a measurement rather than a model.
 *
 * Encoded as (log2(sg_lp) + LP_LOG_LO) / LP_LOG_SPAN, 16-bit, so the range is
 * [2^-LP_LOG_LO, 2^(LP_LOG_SPAN-LP_LOG_LO)] = [1/64, 1024]. The BIAS matters: an
 * earlier version encoded `log2(max(sg_lp, 1.0))`, which clamped every
 * NON-minifying pixel to exactly 1.0 and so put the whole `|L'| < 1` population
 * inside the `1-3` bucket — making the `<1` row read 0 px by construction and
 * diluting the `1-3` row with pixels that have no error to fix.
 */
const LP_LOG_LO = 6
const LP_LOG_SPAN = 16 // [2^-6, 2^10] = [0.0156, 1024], the sup is 492
function lpFieldPasses(g: BuiltGraph): AaPass[] {
  const passes = g.passes.map((p) => ({ ...p }))
  const last = passes[passes.length - 1]
  const build = (kind: Kind, src: string): string => {
    const L = makeLang(kind)
    const sp = splitShader(src, kind)
    const body = [
      axisPreamble(L, sp), lprimePreamble(L, sp),
      `  ${L.letf('SG_VALID', '1.0')}`,
      `  ${L.out(enc16(L, `(log2(max(sg_lp, 1e-6)) + ${L.fnum(LP_LOG_LO)}) / ${L.fnum(LP_LOG_SPAN)}`))}`,
    ].join('\n')
    return assemble(sp, kind, W, H, body)
  }
  last.wgsl = build('wgsl', last.wgsl)
  last.glslFrag = build('glsl', last.glslFrag)
  return passes
}

function decodeLpField(img: Rgba8): Float64Array {
  const out = new Float64Array(img.width * img.height)
  for (let i = 0; i < out.length; i++) {
    const d = dec16(img, i, LP_LOG_SPAN)
    out[i] = Math.pow(2, d.v - LP_LOG_LO)
  }
  return out
}

interface RatioStats { n: number; median: number; p05: number; p95: number; mean: number; fracWithin1pct: number }
function ratioStats(img: Rgba8, scale: number, margin: number): RatioStats {
  const vals: number[] = []
  for (let y = margin; y < img.height - margin; y++) {
    for (let x = margin; x < img.width - margin; x++) {
      const d = dec16(img, y * img.width + x, scale)
      if (d.valid) vals.push(d.v)
    }
  }
  if (vals.length === 0) return { n: 0, median: 0, p05: 0, p95: 0, mean: 0, fracWithin1pct: 0 }
  vals.sort((a, b) => a - b)
  const q = (p: number): number => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))]
  return {
    n: vals.length, median: q(0.5), p05: q(0.05), p95: q(0.95),
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    fracWithin1pct: vals.filter((v) => Math.abs(v - 1) <= 0.01).length / vals.length,
  }
}

// ===========================================================================
// Stimuli
// ===========================================================================

type StimId = 'hicon' | 'flat' | 'step'

function coverCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const s = Math.max(w / img.width, h / img.height)
  const sw = Math.round(img.width * s)
  const sh = Math.round(img.height * s)
  const ox = Math.floor((sw - w) / 2)
  const oy = Math.floor((sh - h) / 2)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = (y + oy + 0.5) / s - 0.5
    const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(sy)))
    const y1 = Math.min(img.height - 1, y0 + 1)
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < w; x++) {
      const sx = (x + ox + 0.5) / s - 0.5
      const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(sx)))
      const x1 = Math.min(img.width - 1, x0 + 1)
      const fx = Math.max(0, Math.min(1, sx - x0))
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c] * (1 - fx) + img.data[(y0 * img.width + x1) * 4 + c] * fx
        const b = img.data[(y1 * img.width + x0) * 4 + c] * (1 - fx) + img.data[(y1 * img.width + x1) * 4 + c] * fx
        out[o + c] = Math.round(a * (1 - fy) + b * fy)
      }
    }
  }
  return { width: w, height: h, data: out }
}

function blurRgba(img: Rgba8, sigma: number): Rgba8 {
  const { width: w, height: h } = img
  const out = new Uint8ClampedArray(w * h * 4)
  for (let c = 0; c < 3; c++) {
    const ch = new Float64Array(w * h)
    for (let i = 0; i < w * h; i++) ch[i] = img.data[i * 4 + c]
    const b = gaussBlur(ch, w, h, sigma)
    for (let i = 0; i < w * h; i++) out[i * 4 + c] = Math.round(b[i])
  }
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = 255
  return { width: w, height: h, data: out }
}

/** Affine-remap RGB so the luma p0.5..p99.5 range spans `span` codes about `mean`. */
function compressToSpan(img: Rgba8, span: number, mean: number): Rgba8 {
  const vals: number[] = []
  for (let i = 0; i < img.data.length; i += 4) {
    vals.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2])
  }
  vals.sort((a, b) => a - b)
  const lo = vals[Math.floor(vals.length * 0.005)]
  const hi = vals[Math.floor(vals.length * 0.995)]
  const g = span / Math.max(hi - lo, 1e-6)
  const mid = (lo + hi) / 2
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((img.data[i + c] - mid) * g + mean)
    out[i + 3] = 255
  }
  return { width: img.width, height: img.height, data: out }
}

/** A 255-code vertical step at 40% width — the metric-resolution ceiling. */
function stepStim(w: number, h: number): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  const cut = Math.round(w * 0.4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < cut ? 0 : 255
      const o = (y * w + x) * 4
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

interface Span { min: number; max: number; span: number; p05: number; p995: number; robustSpan: number; mean: number }
function lumaSpan(f: FloatImg, margin: number): Span {
  const l = lumaF(f)
  const vals: number[] = []
  for (let y = margin; y < f.height - margin; y++) {
    for (let x = margin; x < f.width - margin; x++) vals.push(l[y * f.width + x])
  }
  vals.sort((a, b) => a - b)
  const q = (p: number): number => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * p)))]
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  return {
    min: vals[0], max: vals[vals.length - 1], span: vals[vals.length - 1] - vals[0],
    p05: q(0.005), p995: q(0.995), robustSpan: q(0.995) - q(0.005), mean,
  }
}

const PHOTO = path.join(REPO, 'stuff', '5468102179_8f885a1744_o.jpg')

async function loadStimuli(rig: AaRig): Promise<Record<StimId, Rgba8>> {
  if (!fs.existsSync(PHOTO)) throw new Error(`stimulus photo missing: ${PHOTO}`)
  const decoded = await rig.decodeImage(new Uint8Array(fs.readFileSync(PHOTO)), 'image/jpeg', 2048)
  const hicon = coverCrop(decoded, W, H)
  // The user's chain is blur(radius 51) then warp(srt_scale 4.35), so the content
  // reeded glass samples varies over ~51/3 * 4.35 = 74 device px. Blur to that
  // scale, then squeeze to the measured ~30-code span.
  const flat = compressToSpan(blurRgba(hicon, 74 / 3), 30, 128)
  return { hicon, flat, step: stepStim(W, H) }
}

// ===========================================================================
// Rendering
// ===========================================================================

const graphCache = new Map<string, BuiltGraph>()
function graphFor(cfg: ReedCfg): BuiltGraph {
  const key = JSON.stringify(cfg)
  let g = graphCache.get(key)
  if (!g) { g = buildGraph(cfg, W / H); graphCache.set(key, g) }
  return g
}

function ctxFor(g: BuiltGraph, cfg: ReedCfg): CandCtx {
  return { sampler: g.texSampler, ior: cfg.ior ?? 1.5, curvature: cfg.curvature ?? 0.8 }
}

/** Tiles per axis so no more than 64 taps land in one 8-bit write. */
function tilesFor(n: number): number {
  if (n <= 8) return 1
  let t = 1
  while ((n / t) * (n / t) > 64) t *= 2
  return t
}

interface RenderOpts { dpr: number; backend: Backend; stim: Rgba8; time?: number; timeRepeats?: number }

async function render(rig: AaRig, cfg: ReedCfg, cand: Candidate, o: RenderOpts): Promise<{ img: FloatImg; gpuNs: number | null; timing: string }> {
  const g = graphFor(cfg)
  const ctx = ctxFor(g, cfg)
  if (cand.grid) {
    const t = tilesFor(cand.grid.n)
    const acc = zerosF(W, H)
    let ns = 0
    let method = 'none'
    for (let ty = 0; ty < t; ty++) {
      for (let tx = 0; tx < t; tx++) {
        const passes = candidatePasses(g, cand, ctx, 'color', { n: cand.grid.n, t, tx, ty })
        const r = await rig.run({
          backend: o.backend, width: W, height: H, dpr: o.dpr, time: o.time ?? 0,
          passes, images: { [g.imageSampler]: o.stim }, timeRepeats: o.timeRepeats ?? 0,
        })
        addInto(acc, r.image, 1 / (t * t))
        if (r.gpuNs != null) { ns += r.gpuNs; method = r.timingMethod }
      }
    }
    return { img: acc, gpuNs: ns > 0 ? ns : null, timing: `${method} (sum of ${t * t} tiles)` }
  }
  const passes = candidatePasses(g, cand, ctx, 'color')
  const r = await rig.run({
    backend: o.backend, width: W, height: H, dpr: o.dpr, time: o.time ?? 0,
    passes, images: { [g.imageSampler]: o.stim }, timeRepeats: o.timeRepeats ?? 0,
  })
  return { img: fromRgba8(r.image), gpuNs: r.gpuNs, timing: r.timingMethod }
}

async function renderCount(rig: AaRig, cfg: ReedCfg, cand: Candidate, o: RenderOpts): Promise<{ mean: number; min: number; max: number }> {
  const g = graphFor(cfg)
  const ctx = ctxFor(g, cfg)
  const passes = candidatePasses(g, cand, ctx, 'count', cand.grid ? { n: cand.grid.n, t: 1, tx: 0, ty: 0 } : undefined)
  const r = await rig.run({
    backend: o.backend, width: W, height: H, dpr: o.dpr, passes, images: { [g.imageSampler]: o.stim },
  })
  return decodeCount(r.image, MARGIN)
}

// ===========================================================================
// Output helpers
// ===========================================================================

function writePng(name: string, img: Rgba8): string {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const p = path.join(OUT_DIR, name)
  fs.writeFileSync(p, encodePng(img))
  return p
}

function nnZoom(img: Rgba8, k: number): Rgba8 {
  const w = img.width * k
  const h = img.height * k
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = img.data[s + c]
    }
  }
  return { width: w, height: h, data: out }
}

function hstack(imgs: Rgba8[], gap: number, gapColor: [number, number, number]): Rgba8 {
  const h = Math.max(...imgs.map((i) => i.height))
  const w = imgs.reduce((a, i) => a + i.width, 0) + gap * (imgs.length - 1)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = gapColor[0]; out[i + 1] = gapColor[1]; out[i + 2] = gapColor[2]; out[i + 3] = 255
  }
  let ox = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const s = (y * im.width + x) * 4
        const o = (y * w + (ox + x)) * 4
        for (let c = 0; c < 4; c++) out[o + c] = im.data[s + c]
      }
    }
    ox += im.width + gap
  }
  return { width: w, height: h, data: out }
}

/**
 * 6x magnified seam crop of every column, every column stretched by the SAME
 * linear map taken from the GT crop, so a contrast change reads as a contrast
 * change and not as a normalisation artefact.
 *
 * Rendered as LUMA, not RGB. The first version of this plate mapped RGB through a
 * luma-derived range and the flat stimulus's colour cast pushed every channel to
 * a rail: the output was solid cyan/green/black with no readable structure. Luma
 * is also what every metric here measures, so the plate and the numbers now look
 * at the same quantity.
 */
function seamPlateLuma(cols: Array<{ label: string; img: FloatImg }>, gtIdx: number, x0: number, y0: number, cw: number, ch: number, zoom: number): Rgba8 {
  const cropLuma = (f: FloatImg): { w: number; h: number; l: Float64Array } => {
    const l = new Float64Array(cw * ch)
    const full = lumaF(f)
    for (let y = 0; y < ch; y++) {
      const sy = Math.max(0, Math.min(f.height - 1, y0 + y))
      for (let x = 0; x < cw; x++) {
        const sx = Math.max(0, Math.min(f.width - 1, x0 + x))
        l[y * cw + x] = full[sy * f.width + sx]
      }
    }
    return { w: cw, h: ch, l }
  }
  const gt = cropLuma(cols[gtIdx].img)
  const sorted = [...gt.l].sort((a, b) => a - b)
  const lo = sorted[Math.floor(sorted.length * 0.01)]
  const hi = sorted[Math.floor(sorted.length * 0.99)]
  const gain = 255 / Math.max(hi - lo, 1e-6)
  const toGray = (f: FloatImg): Rgba8 => {
    const { l } = cropLuma(f)
    const out = new Uint8ClampedArray(cw * ch * 4)
    for (let i = 0; i < cw * ch; i++) {
      const v = Math.round(Math.max(0, Math.min(255, (l[i] - lo) * gain)))
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255
    }
    return { width: cw, height: ch, data: out }
  }
  return hstack(cols.map((c) => nnZoom(toGray(c.img), zoom)), 4, [255, 0, 128])
}

/** Series colours for the row-profile plot, in order. */
const PROFILE_COLOURS: Array<[number, number, number]> = [
  [255, 80, 80],    // M0        red
  [80, 220, 120],   // M1-adapt8 green
  [255, 200, 60],   // M3-C4     amber
  [120, 160, 255],  // M3-C1     blue
  [235, 235, 235],  // GT64      white
]

/**
 * One scanline's luma vs x, several candidates overlaid. The 6x luma crop shows
 * that something changed; this shows exactly WHAT — whether the caustic keeps its
 * narrow dark companion or whether the pair has merged into one broad band.
 * Auto-scaled to the union of all series, with the range printed by the caller.
 */
function profilePlot(series: Array<{ label: string; l: Float64Array }>, row: number, x0: number, x1: number): Rgba8 {
  const n = x1 - x0
  const sx = 6
  const h = 320
  const w = n * sx
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) { out[i * 4] = 18; out[i * 4 + 1] = 18; out[i * 4 + 2] = 26; out[i * 4 + 3] = 255 }
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) for (let x = x0; x < x1; x++) { const v = s.l[row * W + x]; if (v < lo) lo = v; if (v > hi) hi = v }
  const pad = (hi - lo) * 0.06 + 0.5
  lo -= pad; hi += pad
  const yOf = (v: number): number => Math.round(h - 1 - ((v - lo) / Math.max(hi - lo, 1e-6)) * (h - 1))
  // horizontal gridlines every 5 codes
  for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) {
    const y = yOf(v)
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = 48; out[o + 1] = 48; out[o + 2] = 60 }
  }
  // Draw LAST-to-FIRST so series[0] ends up on top: the reference is usually the
  // last entry and, drawn last, it painted over every candidate it was meant to be
  // compared against. Each sample fills its whole sx-wide cell plus the vertical
  // connector to the previous one, so the trace is a continuous step line rather
  // than the 3-px dashes the first version produced at sx = 6.
  for (let si = series.length - 1; si >= 0; si--) {
    const s = series[si]
    const [r, g, b] = PROFILE_COLOURS[si % PROFILE_COLOURS.length]
    let py = -1
    for (let x = x0; x < x1; x++) {
      const cy = yOf(s.l[row * W + x])
      const cx = (x - x0) * sx
      const paint = (xx: number, y: number): void => {
        if (xx < 0 || xx >= w || y < 0 || y >= h) return
        const o = (y * w + xx) * 4
        out[o] = r; out[o + 1] = g; out[o + 2] = b
      }
      // horizontal run for this sample, 2 px thick
      for (let dx = 0; dx < sx; dx++) for (let dy = 0; dy < 2; dy++) paint(cx + dx, cy + dy)
      // vertical connector to the previous sample
      if (py >= 0) {
        for (let y = Math.min(py, cy); y <= Math.max(py, cy); y++) for (let dx = 0; dx < 2; dx++) paint(cx + dx, y)
      }
      py = cy
    }
  }
  return { width: w, height: h, data: out }
}

/** Same crops, but showing 8x-amplified |candidate - GT| so the artefact itself
 *  is visible rather than inferred. */
function seamPlateDiff(cols: Array<{ label: string; img: FloatImg }>, gt: FloatImg, x0: number, y0: number, cw: number, ch: number, zoom: number, amp: number): Rgba8 {
  const lg = lumaF(gt)
  const mk = (f: FloatImg): Rgba8 => {
    const lc = lumaF(f)
    const out = new Uint8ClampedArray(cw * ch * 4)
    for (let y = 0; y < ch; y++) {
      const sy = Math.max(0, Math.min(f.height - 1, y0 + y))
      for (let x = 0; x < cw; x++) {
        const sx = Math.max(0, Math.min(f.width - 1, x0 + x))
        const d = (lc[sy * f.width + sx] - lg[sy * f.width + sx]) * amp
        const o = (y * cw + x) * 4
        // signed: red = candidate brighter, blue = darker
        out[o] = Math.round(Math.max(0, Math.min(255, 128 + d)))
        out[o + 1] = Math.round(Math.max(0, Math.min(255, 128 - Math.abs(d))))
        out[o + 2] = Math.round(Math.max(0, Math.min(255, 128 - d)))
        out[o + 3] = 255
      }
    }
    return { width: cw, height: ch, data: out }
  }
  return hstack(cols.map((c) => nnZoom(mk(c.img), zoom)), 4, [255, 255, 0])
}

// ===========================================================================
// Emit check — every candidate x every config x both languages, no GPU.
// Catches a broken source patch or a broken split in a second instead of after a
// browser launch, and every patch asserts its own hit count so a compiler output
// change fails loudly rather than silently doing nothing.
// ===========================================================================

function runEmit(dump: boolean): { rows: Array<Record<string, unknown>>; failures: string[] } {
  const rows: Array<Record<string, unknown>> = []
  const failures: string[] = []
  for (const c of CONFIGS) {
    const g = graphFor(c.cfg)
    const ctx = ctxFor(g, c.cfg)
    for (const cand of CANDIDATES) {
      for (const mode of ['color', 'count'] as Mode[]) {
        try {
          const p = candidatePasses(g, cand, ctx, mode, cand.grid ? { n: cand.grid.n, t: tilesFor(cand.grid.n), tx: 0, ty: 0 } : undefined)
          const last = p[p.length - 1]
          rows.push({
            cfg: c.id, cand: cand.id, mode,
            wgslLines: last.wgsl.split('\n').length, glslLines: last.glslFrag.split('\n').length,
          })
          if (dump && c.id === 'user' && mode === 'color') {
            writeText(`p14min-emit-${cand.id}.wgsl`, last.wgsl)
            writeText(`p14min-emit-${cand.id}.frag`, last.glslFrag)
          }
        } catch (e) {
          const msg = `${c.id}/${cand.id}/${mode}: ${(e as Error).message}`
          failures.push(msg)
          console.error(`  EMIT FAIL ${msg}`)
        }
      }
    }
  }
  // The probe passes too — they are part of the metric chain. BOTH lprime arms:
  // the first version called `fn(g)` for a two-argument function, which passed
  // `undefined` for `which` and therefore only ever built the 'full' arm.
  for (const c of CONFIGS) {
    const g = graphFor(c.cfg)
    const probes: Array<[string, () => AaPass[]]> = [
      ['seamProbe', () => seamProbePasses(g)],
      ['lprimeProbe/rib', () => lprimeProbePasses(g, 'rib')],
      ['lprimeProbe/full', () => lprimeProbePasses(g, 'full')],
    ]
    for (const [name, fn] of probes) {
      try { fn() } catch (e) { failures.push(`${c.id}/${name}: ${(e as Error).message}`); console.error(`  EMIT FAIL ${c.id}/${name}: ${(e as Error).message}`) }
    }
  }
  console.log(`  emit: ${rows.length} shader pairs built, ${failures.length} failures`)
  return { rows, failures }
}

function writeText(name: string, text: string): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, name), text)
}

// ===========================================================================
// Diagnostics (--diag) — used to chase the E1 anomaly at the node defaults
// ===========================================================================

async function runDiag(rig: AaRig, backend: Backend): Promise<void> {
  const stimuli = await loadStimuli(rig)
  for (const cid of ['defaults', 'user']) {
    const cfg = CFG_BY_ID[cid].cfg
    const g = graphFor(cfg)
    const ctx = ctxFor(g, cfg)
    for (const id of ['E1-extrap', 'E1-reeval']) {
      const p = candidatePasses(g, CAND_BY_ID[id], ctx, 'color')
      writeText(`p14min-diag-${cid}-${id}.wgsl`, p[p.length - 1].wgsl)
      writeText(`p14min-diag-${cid}-${id}.frag`, p[p.length - 1].glslFrag)
    }
    const ex = (await render(rig, cfg, CAND_BY_ID['E1-extrap'], { dpr: 1.5, backend, stim: stimuli.hicon })).img
    const rv = (await render(rig, cfg, CAND_BY_ID['E1-reeval'], { dpr: 1.5, backend, stim: stimuli.hicon })).img
    const f = diffField(ex, rv, MARGIN)
    // the node's own seam field, to place the outliers
    const sf = decodeSeamField((await rig.run({
      backend, width: W, height: H, dpr: 1.5, passes: seamProbePasses(g), images: { [g.imageSampler]: stimuli.hicon },
    })).image, SEAM_RANGE_PX)
    const hist: Record<string, number> = {}
    const outliers: Array<{ x: number; y: number; d: number; ss: number }> = []
    for (let y = MARGIN; y < H - MARGIN; y++) {
      for (let x = MARGIN; x < W - MARGIN; x++) {
        const i = y * W + x
        const d = f[i]
        const b = d === 0 ? '0' : d < 1 ? '<1' : d < 4 ? '1-4' : d < 16 ? '4-16' : d < 64 ? '16-64' : '>=64'
        hist[b] = (hist[b] ?? 0) + 1
        if (d >= 16) outliers.push({ x, y, d, ss: sf.dist[i] })
      }
    }
    outliers.sort((a, b) => b.d - a.d)
    console.log(`  diag ${cid}: hist ${JSON.stringify(hist)}`)
    console.log(`  diag ${cid}: ${outliers.length} px >= 16 codes; top: ${outliers.slice(0, 8).map((o) => `(${o.x},${o.y}) d=${o.d.toFixed(0)} ss=${o.ss.toFixed(3)}px`).join(' ')}`)
    const ssAbs = outliers.map((o) => Math.abs(o.ss)).sort((a, b) => a - b)
    if (ssAbs.length) {
      console.log(`  diag ${cid}: |seam distance| of the outliers — p05 ${ssAbs[Math.floor(ssAbs.length * 0.05)].toFixed(3)} median ${ssAbs[Math.floor(ssAbs.length / 2)].toFixed(3)} p95 ${ssAbs[Math.floor(ssAbs.length * 0.95)].toFixed(3)} px`)
    }
    const amp = zerosF(W, H)
    for (let i = 0; i < W * H; i++) {
      const v = Math.min(255, f[i] * 8)
      amp.data[i * 4] = v; amp.data[i * 4 + 1] = v; amp.data[i * 4 + 2] = v; amp.data[i * 4 + 3] = 255
    }
    writePng(`p14min-diag-${cid}-E1diff-8x.png`, toRgba8(amp))
  }
}

// ===========================================================================
// Validation
// ===========================================================================

interface Gate {
  id: string
  what: string
  measured: string
  criterion: string
  pass: boolean
}

interface CalRow {
  metric: string
  control: string
  kind: 'known-good' | 'known-bad'
  value: number
  unit: string
  fires: boolean
  expected: boolean
  ok: boolean
}

const results: Record<string, unknown> = {}

/** Output-name suffix for this run (`--out=-pass2`). Empty for the primary run.
 *  A second pass that ADDS candidates must not overwrite the first pass's sweep. */
let OUT_SUFFIX = ''
const outPath = (stem: string, ext: string): string =>
  path.join(OUT_DIR, `${stem}${OUT_SUFFIX}.${ext}`)

function fmtR(r: Resid): string {
  return `n=${r.n} mean ${r.mean.toFixed(3)} rmse ${r.rmse.toFixed(3)} p99.9 ${r.p999.toFixed(1)} max ${r.max.toFixed(1)} @${r.at}`
}

async function runValidate(rig: AaRig, backends: Backend[]): Promise<void> {
  const gates: Gate[] = []
  const add = (id: string, what: string, measured: string, criterion: string, pass: boolean): void => {
    gates.push({ id, what, measured, criterion, pass })
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${id}  ${what}\n          measured: ${measured}\n          criterion: ${criterion}`)
  }

  const stimuli = await loadStimuli(rig)

  // -----------------------------------------------------------------------
  // V0 — closed-form facts, no GPU. If these disagree with the brief the whole
  // premise is wrong and nothing downstream matters.
  // -----------------------------------------------------------------------
  const analytic: Record<string, unknown> = {}
  for (const c of CONFIGS) {
    const ior = c.cfg.ior ?? 1.5
    const cv = c.cfg.curvature ?? 0.8
    const { k, amp, A } = lensKA(ior, cv)
    analytic[c.id] = {
      ior, curvature: cv, k, amp, A,
      supAbsLprime: supLensDeriv(ior, cv),
      LprimeAtCentre: lensDeriv(0, ior, cv),
      fracMinifying: fracMinifying(ior, cv),
      slopeClampEpsC1: slopeClampEps(ior, cv, 1),
    }
  }
  results.analytic = analytic
  {
    const d = analytic.defaults as { supAbsLprime: number; fracMinifying: number }
    const u = analytic.user as { supAbsLprime: number; fracMinifying: number; A: number }
    add('V0a', "closed form: sup|L'| < 1 STRICTLY at the node defaults (the no-op premise)",
      `sup|L'| = ${d.supAbsLprime.toFixed(6)}, fraction minifying = ${(d.fracMinifying * 100).toFixed(4)}%`,
      "sup|L'| < 1 and 0% minifying", d.supAbsLprime < 1 && d.fracMinifying === 0)
    add('V0b', "closed form reproduces the user's scene numbers",
      `A = ${u.A.toFixed(4)}, sup|L'| = ${u.supAbsLprime.toFixed(2)}, ${(u.fracMinifying * 100).toFixed(3)}% minifies`,
      'A ~ 1.3835 and 52.8-53.0% minifying', Math.abs(u.A - 1.383525) < 1e-4 && u.fracMinifying > 0.527 && u.fracMinifying < 0.530)
  }

  // -----------------------------------------------------------------------
  // V1 — stimulus spans. Says which metric can resolve which stimulus.
  // -----------------------------------------------------------------------
  const spans: Record<string, Span> = {}
  for (const s of ['hicon', 'flat', 'step'] as StimId[]) spans[s] = lumaSpan(fromRgba8(stimuli[s]), MARGIN)
  results.stimulusSpans = spans
  add('V1', 'stimulus luma spans: flat ~30 codes (the user\'s scene), hicon near full range',
    `flat p0.5-p99.5 ${spans.flat.robustSpan.toFixed(1)} (full ${spans.flat.span.toFixed(1)}), hicon ${spans.hicon.robustSpan.toFixed(1)}, step ${spans.step.robustSpan.toFixed(1)} codes`,
    'flat robustSpan in 25..35, hicon > 150, step > 240',
    spans.flat.robustSpan > 25 && spans.flat.robustSpan < 35 && spans.hicon.robustSpan > 150 && spans.step.robustSpan > 240)

  // -----------------------------------------------------------------------
  // V2 — the surgery is INERT. `M0-wrap` re-runs the untouched shipped body
  // through the wrapper at zero offset; if it is not byte-identical to the raw
  // shader, every candidate number is contaminated by the wrapper.
  // -----------------------------------------------------------------------
  const inert: Record<string, unknown> = {}
  for (const backend of backends) {
    for (const cid of ['defaults', 'user']) {
      const cfg = CFG_BY_ID[cid].cfg
      const a = await render(rig, cfg, CAND_BY_ID['M0'], { dpr: 1.5, backend, stim: stimuli.hicon })
      const b = await render(rig, cfg, CAND_BY_ID['M0-wrap'], { dpr: 1.5, backend, stim: stimuli.hicon })
      const r = residual(a.img, b.img, MARGIN)
      inert[`${backend}/${cid}`] = r
      add(`V2 ${backend}/${cid}`, 'M0-wrap (shipped body via the wrapper at zero offset) == M0 raw',
        `max ${r.max.toFixed(3)} codes`, 'max == 0 codes exactly', r.max === 0)
    }
  }
  results.inert = inert

  // -----------------------------------------------------------------------
  // V3 — the closed-form predicate against the map the node ACTUALLY emits.
  // (a) analytic |L'| vs a central difference of the node's own rg_sampleUV
  // (b) the E1 emulation delta: re-evaluated vs first-order-extrapolated rib phase
  // -----------------------------------------------------------------------
  {
    const lprobe: Record<string, unknown> = {}
    for (const backend of backends) {
      for (const cid of ['defaults', 'c100', 'c150', 'user']) {
        const cfg = CFG_BY_ID[cid].cfg
        const g = graphFor(cfg)
        const rib = ratioStats((await rig.run({
          backend, width: W, height: H, dpr: 1.5,
          passes: lprimeProbePasses(g, 'rib'), images: { [g.imageSampler]: stimuli.flat },
        })).image, 2, 20)
        const full = ratioStats((await rig.run({
          backend, width: W, height: H, dpr: 1.5,
          passes: lprimeProbePasses(g, 'full'), images: { [g.imageSampler]: stimuli.flat },
        })).image, 4, 20)
        lprobe[`${backend}/${cid}`] = { rib, full }
        add(`V3a ${backend}/${cid}`, "closed-form |L'| at the pixel centre == a central difference of the node's OWN reedLens",
          rib.n === 0 ? 'no valid pixels' : `median ${rib.median.toFixed(4)} p05 ${rib.p05.toFixed(4)} p95 ${rib.p95.toFixed(4)} over ${rib.n} px, ${(rib.fracWithin1pct * 100).toFixed(1)}% within 1%`,
          'median within 1% of 1.0 and >= 90% of valid pixels within 1%',
          rib.n > 1000 && Math.abs(rib.median - 1) < 0.01 && rib.fracWithin1pct > 0.90)
        add(`V3b ${backend}/${cid}`, "the predicate vs the FULL screen-space normal stretch (a FINDING, not an equality)",
          full.n === 0 ? "no pixels where the predicate fires (config does not minify)"
            : `measured/predicted median ${full.median.toFixed(3)} p95 ${full.p95.toFixed(3)} over ${full.n} px`,
          'reported; gated only against a gross under-estimate (p95 <= 4x)',
          full.n === 0 || full.p95 <= 4)
      }
    }
    results.lprimeProbe = lprobe
  }
  {
    // E1, isolated: the node's OWN first-order phase extrapolation at a fixed
    // +0.5 px offset, against the same tap with the rib field re-evaluated there.
    // Everything else about the two taps is identical.
    const e1: Record<string, unknown> = {}
    for (const backend of backends) {
      for (const cid of ['defaults', 'user']) {
        const cfg = CFG_BY_ID[cid].cfg
        const ex = await render(rig, cfg, CAND_BY_ID['E1-extrap'], { dpr: 1.5, backend, stim: stimuli.hicon })
        const rv = await render(rig, cfg, CAND_BY_ID['E1-reeval'], { dpr: 1.5, backend, stim: stimuli.hicon })
        const r = residual(ex.img, rv.img, MARGIN)
        e1[`${backend}/${cid}`] = r
        add(`V3c ${backend}/${cid}`, `E1 emulation gap: the node's extrapolated tap at +${E1_OFFSET_PX} px vs the same tap re-evaluated`,
          `${fmtR(r)} — ${(r.fracGe1 * 100).toFixed(3)}% of pixels differ at all`,
          cid === 'defaults'
            ? 'straight ribs: algebraically exact except at the SEAM-CROSSING BOUNDARY, where a 1-ulp phase disagreement flips floor(coord/ribW) for a whole COLUMN at once (the decision is y-independent when the ribs are straight). Gated at < 0.5% of pixels differing.'
            : "sine ribs: the boundary is a curve, not a column, so the same effect touches almost nothing; a small O(w''/8) difference remains. Gated at mean < 2 codes.",
          cid === 'defaults' ? r.fracGe1 < 0.005 : r.mean < 2)
      }
    }
    results.e1ExtrapolationDelta = e1
  }

  // -----------------------------------------------------------------------
  // V4 — the GT. Convergence spot-check in THIS harness (the GT phase measured
  // the ladder; this confirms the same reference is reproduced here), plus the
  // cross-backend agreement of the reference itself.
  // -----------------------------------------------------------------------
  const gts = new Map<string, FloatImg>()
  const gtKey = (cid: string, s: StimId, b: Backend, dpr: number, n: number): string => `${cid}/${s}/${b}/${dpr}/${n}`
  const getGt = async (cid: string, s: StimId, b: Backend, dpr: number, n: number): Promise<FloatImg> => {
    const k = gtKey(cid, s, b, dpr, n)
    let v = gts.get(k)
    if (!v) {
      v = (await render(rig, CFG_BY_ID[cid].cfg, CAND_BY_ID[`M6-GT${n}`], { dpr, backend: b, stim: stimuli[s] })).img
      gts.set(k, v)
    }
    return v
  }
  {
    const conv: Record<string, unknown> = {}
    for (const s of ['flat', 'hicon'] as StimId[]) {
      const b: Backend = backends[0]
      const g16 = await getGt('user', s, b, 1.5, 16)
      const g32 = await getGt('user', s, b, 1.5, 32)
      const g64 = await getGt('user', s, b, 1.5, 64)
      const r1632 = residual(g16, g64, MARGIN)
      const r3264 = residual(g32, g64, MARGIN)
      conv[s] = { gt16VsGt64: r1632, gt32VsGt64: r3264 }
      add(`V4a ${s}`, 'the 64x64 reference is converged: |GT32 - GT64| is small vs |GT16 - GT64|',
        `|GT16-GT64| rmse ${r1632.rmse.toFixed(3)}, |GT32-GT64| rmse ${r3264.rmse.toFixed(3)} codes (ratio ${(r1632.rmse / Math.max(r3264.rmse, 1e-6)).toFixed(2)}x)`,
        '|GT32-GT64| rmse < 0.5 codes and at least 2x below |GT16-GT64|',
        r3264.rmse < 0.5 && r1632.rmse > 1.8 * r3264.rmse)
    }
    results.gtConvergence = conv
  }
  if (backends.length === 2) {
    const a = await getGt('user', 'flat', backends[0], 1.5, 32)
    const b = await getGt('user', 'flat', backends[1], 1.5, 32)
    const r = residual(a, b, MARGIN)
    results.gtCrossBackend = r
    add('V4b', 'the GT agrees across backends (the parity floor every candidate is judged against)',
      `|GT32(webgpu) - GT32(webgl2)| ${fmtR(r)}`,
      'mean < 1.0 code (filter/rounding differences only)', r.mean < 1.0)
  }

  // -----------------------------------------------------------------------
  // V5 — opacity, which is what makes straight-alpha tap averaging (E2) exact.
  // -----------------------------------------------------------------------
  {
    let worstA = 255
    for (const s of ['hicon', 'flat', 'step'] as StimId[]) {
      for (const cid of ['defaults', 'user']) {
        const img = (await render(rig, CFG_BY_ID[cid].cfg, CAND_BY_ID['M0'], { dpr: 1.5, backend: backends[0], stim: stimuli[s] })).img
        for (let y = MARGIN; y < H - MARGIN; y++) {
          for (let x = MARGIN; x < W - MARGIN; x++) {
            const a = img.data[(y * W + x) * 4 + 3]
            if (a < worstA) worstA = a
          }
        }
      }
    }
    add('V5', 'every render is fully opaque, so straight-alpha tap averaging (E2) is exact here',
      `min alpha over all stimuli/configs = ${worstA}`, 'min alpha == 255', worstA === 255)
  }

  // -----------------------------------------------------------------------
  // V6 — THE PRIMARY GUARD: every candidate is a no-op at the node defaults.
  // -----------------------------------------------------------------------
  const noop: Array<Record<string, unknown>> = []
  {
    const cfg = CFG_BY_ID['defaults'].cfg
    for (const backend of backends) {
      for (const dpr of DPRS) {
        for (const s of ['hicon', 'flat'] as StimId[]) {
          const base = await render(rig, cfg, CAND_BY_ID['M0'], { dpr, backend, stim: stimuli[s] })
          for (const cand of CANDIDATES) {
            if (cand.family === 'M6') continue // GT is a reference, not a shippable candidate
            if (cand.id === 'M0') continue
            const r0 = await render(rig, cfg, cand, { dpr, backend, stim: stimuli[s] })
            const r = residual(base.img, r0.img, MARGIN)
            const expectedNoop = !cand.unconditional && !cand.probe && cand.id !== 'M0-nosplit'
            noop.push({ backend, dpr, stim: s, cand: cand.id, expectedNoop, max: r.max, mean: r.mean })
            if (expectedNoop && r.max !== 0) {
              add(`V6 ${cand.id} ${backend}/dpr${dpr}/${s}`, 'no-op at the node defaults',
                `max ${r.max.toFixed(3)} mean ${r.mean.toFixed(4)} codes`, 'max == 0 codes exactly', false)
            }
          }
        }
      }
    }
    const violations = noop.filter((n) => n.expectedNoop && n.max !== 0)
    const gated0 = noop.filter((n) => n.expectedNoop)
    add('V6', 'PRIMARY GUARD — every gated candidate is byte-identical to M0 at the node defaults',
      `${gated0.length - violations.length}/${gated0.length} (candidate x backend x dpr x stimulus) cells at max 0 codes; ${violations.length} violations`,
      'zero violations', violations.length === 0)
    const uncond = noop.filter((n) => !n.expectedNoop && n.cand !== 'M0-nosplit' && !String(n.cand).startsWith('E1-'))
    console.log(`  note  V6: UNCONDITIONAL candidates do move the defaults, as designed: ` +
      uncond.map((u) => `${u.cand}=${(u.max as number).toFixed(1)}`).filter((v, i, a) => a.indexOf(v) === i).join(' '))
    const nosplit = noop.filter((n) => n.cand === 'M0-nosplit')
    console.log(`  note  V6: M0-nosplit vs M0 at the defaults: max ` +
      `${Math.max(...nosplit.map((n) => n.max as number)).toFixed(3)} codes ` +
      `(the shipped seam split IS active at the defaults, so this is expected to be nonzero)`)
    results.defaultsNoop = noop
  }

  // -----------------------------------------------------------------------
  // V7 — METRIC CALIBRATION. Every metric against a known-good it must not
  // fire on and a known-bad it must.
  // -----------------------------------------------------------------------
  const cal: CalRow[] = []
  const addCal = (metric: string, control: string, kind: CalRow['kind'], value: number, unit: string, fires: boolean): void => {
    const expected = kind === 'known-bad'
    const ok = fires === expected
    cal.push({ metric, control, kind, value, unit, fires, expected, ok })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${metric.padEnd(18)} ${kind === 'known-bad' ? 'KB' : 'KG'} ${control.padEnd(34)} ${value.toFixed(4).padStart(10)} ${unit.padEnd(9)} fires=${fires}`)
  }

  const B0: Backend = backends[0]
  const CAL_STIM: StimId = 'flat' // rank on the user's content; hicon is the sanity check
  const cfgU = CFG_BY_ID['user'].cfg

  const gt64 = await getGt('user', CAL_STIM, B0, 1.5, 64)
  const gt32 = await getGt('user', CAL_STIM, B0, 1.5, 32)
  const gt8 = await getGt('user', CAL_STIM, B0, 1.5, 8)
  const m0 = (await render(rig, cfgU, CAND_BY_ID['M0'], { dpr: 1.5, backend: B0, stim: stimuli[CAL_STIM] })).img
  const m1x = (await render(rig, cfgU, CAND_BY_ID['M1-N16'], { dpr: 1.5, backend: B0, stim: stimuli[CAL_STIM] })).img
  const m3 = (await render(rig, cfgU, CAND_BY_ID['M3-C1'], { dpr: 1.5, backend: B0, stim: stimuli[CAL_STIM] })).img
  const m5 = (await render(rig, cfgU, CAND_BY_ID['M5'], { dpr: 1.5, backend: B0, stim: stimuli[CAL_STIM] })).img

  // -- error band -----------------------------------------------------------
  const bandAdaptive = bandFromControl(m0, gt64, MARGIN, 0.03, 1.0)
  const band8 = bandFixed(m0, gt64, MARGIN, 8)
  results.band = {
    adaptive: { theta: bandAdaptive.theta, count: bandAdaptive.count, frac: bandAdaptive.frac },
    fixed8: { theta: 8, count: band8.count, frac: band8.frac },
    note: 'the fixed-8 band is reported only for comparability with phase 10/12; on the flat stimulus it selects 16 px and cannot be averaged',
  }
  add('V7-band', "the error band is large enough to average on the user's flat content",
    `adaptive theta ${bandAdaptive.theta.toFixed(2)} codes -> ${bandAdaptive.count} px (${(bandAdaptive.frac * 100).toFixed(2)}%); fixed theta 8 -> ${band8.count} px (${(band8.frac * 100).toFixed(3)}%)`,
    'adaptive band >= 2000 px', bandAdaptive.count >= 2000)

  const errThresh = 0.5 // codes, mean over the band
  const errOf = (a: FloatImg): number => residual(a, gt64, MARGIN, bandAdaptive.mask).mean
  // GT8 is a KNOWN-GOOD, not a known-bad: it was proposed as "deliberately
  // under-converged" and MEASURED at 0.39 codes on the band, i.e. inside the
  // threshold. Calling it a known-bad after measuring it above would be fitting
  // the label to the number, so it is reclassified and the number reported.
  addCal('errVsGT(band)', 'GT32 vs GT64 (converged reference)', 'known-good', errOf(gt32), 'codes', errOf(gt32) > errThresh)
  addCal('errVsGT(band)', 'GT64 vs itself', 'known-good', errOf(gt64), 'codes', errOf(gt64) > errThresh)
  addCal('errVsGT(band)', 'GT8 (8x8 is already inside the threshold)', 'known-good', errOf(gt8), 'codes', errOf(gt8) > errThresh)
  addCal('errVsGT(band)', 'M0 shipped 1 tap', 'known-bad', errOf(m0), 'codes', errOf(m0) > errThresh)
  addCal('errVsGT(band)', 'M5 coordinate taper (refuted)', 'known-bad', errOf(m5), 'codes', errOf(m5) > errThresh)

  // -- look preservation ----------------------------------------------------
  // The sigma is CHOSEN BY THE CALIBRATION, not a priori: a sweep is run and the
  // value that best separates the primary known-good set from the primary
  // known-bad set is used, then reported. The threshold is 3x the worst primary
  // known-good, so it can never be tuned to let a known-bad through.
  const noiseRms = residual(m0, gt64, MARGIN).rmse
  const kgNoise = addWhiteNoise(gt64, noiseRms, 12345)
  const kbFlat = scaleContrast(gt64, 0.85)
  const kbShift = shiftSubpixel(gt64, 0.5, 0)
  const lookControls: Array<{ id: string; img: FloatImg; cls: 'kg' | 'kb-primary' | 'kb-secondary' }> = [
    { id: 'GT8', img: gt8, cls: 'kg' },
    { id: 'GT32', img: gt32, cls: 'kg' },
    { id: `white noise @M0 rms (${noiseRms.toFixed(3)} codes)`, img: kgNoise, cls: 'kg' },
    { id: 'M1-N16 (a real fix)', img: m1x, cls: 'kg' },
    { id: 'M0 (aliased, same look)', img: m0, cls: 'kg' },
    { id: 'M3-C1 slope clamp', img: m3, cls: 'kb-primary' },
    { id: 'contrast x0.85', img: kbFlat, cls: 'kb-primary' },
    { id: 'shift 0.5 px', img: kbShift, cls: 'kb-secondary' },
    { id: 'M5 taper', img: m5, cls: 'kb-secondary' },
  ]
  const sweep: Array<{ sigmaPx: number; kgMax: number; kbPrimaryMin: number; separation: number }> = []
  for (const s of [2, 4, 8, 12]) {
    const vals = lookControls.map((c) => ({ ...c, v: lookDelta(c.img, gt64, s, MARGIN).norm }))
    const kgMax = Math.max(...vals.filter((v) => v.cls === 'kg').map((v) => v.v))
    const kbPrimaryMin = Math.min(...vals.filter((v) => v.cls === 'kb-primary').map((v) => v.v))
    sweep.push({ sigmaPx: s, kgMax, kbPrimaryMin, separation: kbPrimaryMin / Math.max(kgMax, 1e-12) })
  }
  const best = sweep.reduce((a, b) => (b.separation > a.separation ? b : a))
  const lookSigma = best.sigmaPx
  const lookRows: Record<string, LookResult & { cls: string }> = {}
  for (const c of lookControls) lookRows[c.id] = { ...lookDelta(c.img, gt64, lookSigma, MARGIN), cls: c.cls }
  const lookThresh = 3 * best.kgMax
  results.look = {
    sigmaSweep: sweep, chosenSigmaPx: lookSigma, threshold: lookThresh,
    rows: lookRows, kgMax: best.kgMax, kbPrimaryMin: best.kbPrimaryMin, separation: best.separation,
    note: 'threshold = 3x the worst known-good. Secondary known-bads below it are the metric\'s MEASURED sensitivity floor, reported as such.',
  }
  console.log(`  look sigma sweep: ${sweep.map((s) => `s${s.sigmaPx}=${s.separation.toFixed(1)}x`).join(' ')} -> chose sigma ${lookSigma} px`)
  for (const c of lookControls) {
    const v = lookRows[c.id].norm
    if (c.cls === 'kb-secondary') {
      console.log(`  note  lookDelta(norm) KB-secondary ${c.id.padEnd(34)} ${v.toFixed(5).padStart(10)} fraction  ` +
        `${v > lookThresh ? 'above' : 'BELOW'} the threshold ${lookThresh.toFixed(5)} (${(v / Math.max(best.kgMax, 1e-12)).toFixed(1)}x the known-good floor)`)
      continue
    }
    addCal('lookDelta(norm)', c.id, c.cls === 'kg' ? 'known-good' : 'known-bad', v, 'fraction', v > lookThresh)
  }
  add('V7-look', 'the look metric separates a flattening from a denoise with margin',
    `sigma ${lookSigma} px: worst known-good ${best.kgMax.toFixed(5)}, best primary known-bad ${best.kbPrimaryMin.toFixed(5)}, separation ${best.separation.toFixed(1)}x, threshold ${lookThresh.toFixed(5)}`,
    'primary separation >= 4x (threshold is 3x the worst known-good, so this leaves margin)', best.separation >= 4)

  // -- caustic contrast preservation (the second look axis) -----------------
  // Window picked from the REFERENCE, never from a candidate.
  const trackWin = pickTrackWindow(gt64, bandAdaptive.mask)
  const lGt = lumaF(gt64)
  const seed = trackSeed(lGt, W, trackWin.x0, trackWin.x1, trackWin.y0)
  const ccGt = causticContrast(lGt, W, H, trackWin.x0, trackWin.x1, trackWin.y0, trackWin.y1)
  const ccOf = (a: FloatImg): number =>
    causticContrast(lumaF(a), W, H, trackWin.x0, trackWin.x1, trackWin.y0, trackWin.y1).median / Math.max(ccGt.median, 1e-9)
  const ccControls: Array<{ id: string; img: FloatImg; kb: boolean }> = [
    { id: 'GT32', img: gt32, kb: false },
    { id: 'M1-N16', img: m1x, kb: false },
    { id: 'M0', img: m0, kb: false },
    { id: 'white noise @M0 rms', img: kgNoise, kb: false },
    { id: 'M3-C1', img: m3, kb: true },
    { id: 'contrast x0.85', img: kbFlat, kb: true },
  ]
  const ccVals = ccControls.map((c) => ({ ...c, v: ccOf(c.img) }))
  const ccKgWorst = Math.max(...ccVals.filter((v) => !v.kb).map((v) => Math.abs(1 - v.v)))
  const ccKbBest = Math.min(...ccVals.filter((v) => v.kb).map((v) => Math.abs(1 - v.v)))
  const ccUsable = ccKbBest > 2 * ccKgWorst
  const ccThresh = ccUsable ? Math.sqrt(ccKgWorst * ccKbBest) : NaN
  results.causticContrast = {
    window: trackWin, gtMedianCodes: ccGt.median,
    ratios: Object.fromEntries(ccVals.map((v) => [v.id, v.v])),
    kgWorstDeviation: ccKgWorst, kbBestDeviation: ccKbBest, usable: ccUsable, threshold: ccThresh,
  }
  if (ccUsable) {
    for (const v of ccVals) addCal('causticContrast', v.id, v.kb ? 'known-bad' : 'known-good', v.v, 'x', Math.abs(1 - v.v) > ccThresh)
  } else {
    console.log(`  note  causticContrast DROPPED: known-good deviation reaches ${ccKgWorst.toFixed(4)} while the best known-bad is only ${ccKbBest.toFixed(4)} — the ranges overlap, so no threshold separates them. ` +
      `Ratios: ${ccVals.map((v) => `${v.id}=${v.v.toFixed(4)}`).join(' ')}`)
  }
  // A DECISION RECORD, not a pass/fail: the bench's job here is to decide whether
  // this axis can be calibrated, and to say so either way. Shipping it as a
  // failing gate would read as a broken bench; hiding the overlap would ship a
  // gate that lies.
  add('V7-caustic (decision)', 'can the caustic-contrast axis be calibrated on this content?',
    ccUsable
      ? `KEPT. GT median cross-rib contrast ${ccGt.median.toFixed(2)} codes; worst known-good deviation ${ccKgWorst.toFixed(4)}, best known-bad ${ccKbBest.toFixed(4)}, threshold ${ccThresh.toFixed(4)}`
      : `DROPPED. Known-good deviation reaches ${ccKgWorst.toFixed(4)} while the best known-bad is only ${ccKbBest.toFixed(4)} — the ranges OVERLAP, so no threshold separates them. lookDelta carries the look question alone, backed by the 6x seam plate.`,
    'decision recorded either way; the metric is used only if the known-bad deviation exceeds 2x the worst known-good', true)

  // -- staircase / contour jitter ------------------------------------------
  //
  // THE ESTIMATOR IS VALIDATED ON THE REFERENCE BEFORE IT IS USED ON ANYTHING.
  // A global argmax MEASURED jumpP95 2.98 px on GT64 ITSELF, and a radius-3
  // constrained tracker MEASURED 3.10 px on GT64 — it saturated its own search
  // radius, because the user's rib carries 8 mirror-wrap folds and several sit
  // 1-3 px apart, so there is no single contour to follow in an arbitrary window.
  //
  // So: pre-smooth by sigma 1 to merge the sub-pixel folds, then SEARCH the
  // y-band for the column where the REFERENCE's own tracked contour is smoothest,
  // and require it to be near the geometric slope (the sine rib's max lateral
  // slope is amplitude*2*pi/wavelength = 0.218 px/row). If no window in the frame
  // gets the reference under that, the metric is DROPPED — a jitter number
  // measured where the reference itself jitters would be meaningless.
  const TRUE_SLOPE_PX_PER_ROW = 0.218
  const trackRadius = 2
  // Window selection has TWO conditions, and the first version had only one.
  // Optimising for "the reference tracks smoothest" alone MEASURED a window
  // (x[204,244]) where the reference read 0.035 px and the 1-tap control read
  // 0.069 px — i.e. it found a window where nothing is wrong, and the known-bad
  // stopped being bad. The window must ALSO contain the artefact, so the search is
  // over windows in the top quartile of error-band density.
  // Smoothing sigma is swept and the SMALLEST value that lets the reference
  // qualify is used, because smoothing is what erases the jitter being measured.
  const bandDensity = (x0: number, x1: number): number => {
    let n = 0
    for (let y = trackWin.y0; y < trackWin.y1; y++) for (let x = x0; x < x1; x++) n += bandAdaptive.mask[y * W + x]
    return n
  }
  const winCandidates: Array<{ x0: number; x1: number; dens: number }> = []
  for (let cx = MARGIN + 22; cx < W - MARGIN - 22; cx += 2) {
    winCandidates.push({ x0: cx - 20, x1: cx + 20, dens: bandDensity(cx - 20, cx + 20) })
  }
  const densSorted = [...winCandidates].map((c) => c.dens).sort((a, b) => a - b)
  const densQ75 = densSorted[Math.floor(densSorted.length * 0.75)]
  const artefactWins = winCandidates.filter((c) => c.dens >= densQ75)
  let bestWin: { x0: number; x1: number; seed: number; gtJump: number; dens: number; sigma: number } = {
    x0: trackWin.x0, x1: trackWin.x1, seed, gtJump: Infinity, dens: 0, sigma: 0,
  }
  const stAtS = (a: FloatImg, x0: number, x1: number, sd: number, sig: number): SeamTrack =>
    seamTrack(lumaF(a), W, x0, x1, trackWin.y0, trackWin.y1, {
      seed: sd, radius: trackRadius, smoothSigma: sig, height: H,
    })
  for (const sig of [0, 0.5, 1.0]) {
    const lSm = gaussBlur(lGt, W, H, sig)
    let pick: typeof bestWin | null = null
    for (const c of artefactWins) {
      const sd = trackSeed(lSm, W, c.x0, c.x1, trackWin.y0)
      // `sig` MUST be threaded here: the first version dropped it, so the search
      // always tracked unsmoothed luma while the loop pretended to sweep sigma.
      // It happened not to change the outcome (sigma 0 qualified first, so the
      // fallback never ran) but the fallback could never have worked.
      const gj = stAtS(gt64, c.x0, c.x1, sd, sig).jumpP95
      if (gj > 3 * TRUE_SLOPE_PX_PER_ROW) continue
      if (!pick || c.dens > pick.dens) pick = { x0: c.x0, x1: c.x1, seed: sd, gtJump: gj, dens: c.dens, sigma: sig }
    }
    if (pick) { bestWin = pick; break }
  }
  const trackSmooth = bestWin.sigma
  const stAt = (a: FloatImg, x0: number, x1: number, sd: number): SeamTrack => stAtS(a, x0, x1, sd, trackSmooth)
  const jitUsable = bestWin.gtJump <= 3 * TRUE_SLOPE_PX_PER_ROW
  const jitThresh = jitUsable ? 3 * bestWin.gtJump : NaN
  const jits: Record<string, SeamTrack> = {
    'KG GT64': stAt(gt64, bestWin.x0, bestWin.x1, bestWin.seed),
    'KG GT32': stAt(gt32, bestWin.x0, bestWin.x1, bestWin.seed),
    'KG M1-N16': stAt(m1x, bestWin.x0, bestWin.x1, bestWin.seed),
    'KB M0': stAt(m0, bestWin.x0, bestWin.x1, bestWin.seed),
  }
  // A known-bad that does not fire means the metric has no discrimination HERE,
  // whatever the reference does — so the metric is dropped, not the gate relaxed.
  const jitDiscriminates = jitUsable && jits['KB M0'].jumpP95 > jitThresh
  results.seamTrack = {
    searchedWindow: bestWin, yBand: [trackWin.y0, trackWin.y1], radiusPx: trackRadius,
    smoothSigmaPx: trackSmooth, trueSlopePxPerRow: TRUE_SLOPE_PX_PER_ROW,
    bandDensityQ75: densQ75, windowsConsidered: artefactWins.length,
    referenceQualifies: jitUsable, discriminates: jitDiscriminates, threshold: jitThresh, rows: jits,
  }
  if (jitDiscriminates) {
    for (const [k, v] of Object.entries(jits)) {
      addCal('seamJumpP95', k.slice(3), k.startsWith('KB') ? 'known-bad' : 'known-good', v.jumpP95, 'px', v.jumpP95 > jitThresh)
    }
  } else {
    console.log(`  note  seamJumpP95 DROPPED. ${jitUsable
      ? `The reference tracks cleanly (${bestWin.gtJump.toFixed(3)} px) but the 1-tap control tracks just as cleanly (${jits['KB M0'].jumpP95.toFixed(3)} px vs a ${jitThresh.toFixed(3)} px threshold) — the metric has no known-bad to fire on, so it cannot rank anything.`
      : `No window with the artefact present gets the CONVERGED REFERENCE under ${(3 * TRUE_SLOPE_PX_PER_ROW).toFixed(3)} px (best ${bestWin.gtJump.toFixed(3)} px vs a ${TRUE_SLOPE_PX_PER_ROW} px/row true slope) — a jitter number here would be measuring the estimator, not the candidate.`
      } Values anyway: ${Object.entries(jits).map(([k, v]) => `${k}=${v.jumpP95.toFixed(3)}`).join(' ')}`)
  }
  add('V7-jitter (decision)', "can contour jitter be measured at the user's curvature?",
    jitDiscriminates
      ? `KEPT. Window x[${bestWin.x0},${bestWin.x1}] (band density ${bestWin.dens}, smoothing sigma ${trackSmooth}) puts GT64 at jumpP95 ${bestWin.gtJump.toFixed(3)} px and M0 at ${jits['KB M0'].jumpP95.toFixed(3)} px; threshold ${jitThresh.toFixed(3)} px`
      : `DROPPED. Searched ${artefactWins.length} artefact-bearing windows x 3 smoothing sigmas. ${jitUsable
        ? `Best: GT64 ${bestWin.gtJump.toFixed(3)} px, M0 ${jits['KB M0'].jumpP95.toFixed(3)} px, threshold ${jitThresh.toFixed(3)} px — the known-bad does not separate from the reference.`
        : `Best GT64 ${bestWin.gtJump.toFixed(3)} px, above the ${(3 * TRUE_SLOPE_PX_PER_ROW).toFixed(3)} px ceiling.`
      } errVsGT(band), causticContrast and the 6x plates carry the staircase question instead.`,
    'the reference must track within 3x its geometric slope AND the 1-tap control must exceed the threshold, else DROPPED', true)

  // -- lib/edge-metrics staircase, for comparability with phase 10/12 -------
  //
  // Run at the USER's curvature AND at curvature 0.80 with the same oblique sine
  // seam. The low-curvature run is the estimator's own known-good: it is the
  // regime phase 10/12 published numbers in. If it is valid there and invalid at
  // 2.15, the estimator is intact and simply cannot be applied at the user's
  // setting — which is a precise statement, not a shrug.
  {
    const stair: Record<string, unknown> = {}
    const usable: string[] = []
    for (const cid of ['userLowCurv', 'user']) {
      for (const s of ['flat', 'hicon'] as StimId[]) {
        const cfg = CFG_BY_ID[cid].cfg
        const g = graphFor(cfg)
        const field = decodeSeamField((await rig.run({
          backend: B0, width: W, height: H, dpr: 1.5,
          passes: seamProbePasses(g), images: { [g.imageSampler]: stimuli[s] },
        })).image, SEAM_RANGE_PX)
        const per: Record<string, unknown> = {}
        for (const candId of ['M0', 'M1-N16', 'M6-GT16']) {
          const img = (await render(rig, cfg, CAND_BY_ID[candId], { dpr: 1.5, backend: B0, stim: stimuli[s] })).img
          per[candId] = staircase(toRgba8(img), field)
        }
        stair[`${cid}/${s}`] = per
        if (Object.values(per).every((v) => (v as { valid: boolean }).valid)) usable.push(`${cid}/${s}`)
        console.log(`  note  edge-metrics staircase ${cid}/${s}: ` +
          Object.entries(per).map(([k, v]) => `${k} rms ${(v as { rmsPx: number }).rmsPx.toFixed(4)}px n=${(v as { n: number }).n} rej=${(v as { rejected: number }).rejected} valid=${(v as { valid: boolean }).valid}`).join('; '))
      }
    }
    const lowOk = usable.some((u) => u.startsWith('userLowCurv'))
    const userOk = usable.some((u) => u.startsWith('user/'))
    results.edgeMetricsStaircase = { rows: stair, usableOn: usable, validAtLowCurvature: lowOk, validAtUserCurvature: userOk }
    add('V7-stair (decision)', 'is lib/edge-metrics.staircase applicable here, and does it still work where phase 10/12 used it?',
      `valid at curvature 0.80: ${lowOk}; valid at the user's curvature 2.15: ${userOk}. Usable cells: ${usable.length ? usable.join(', ') : 'none'}`,
      lowOk && !userOk
        ? 'estimator intact in its calibrated regime but NOT APPLICABLE at curvature 2.15 (too many content-dominated rejections once the rib carries 8 folds) — DROPPED there'
        : 'estimator must be valid in its own calibrated low-curvature regime, else the harness import is broken',
      lowOk)
  }

  // -- grain ---------------------------------------------------------------
  // Measured BOTH whole-frame and inside the error band. Whole-frame is dominated
  // by the photo's own detail and MEASURED insensitive (M4-N4 read 1.004x); the
  // band-restricted column is the one that can see a candidate's own noise.
  const grainThresh = 0.15
  const m4 = (await render(rig, cfgU, CAND_BY_ID['M4-N4'], { dpr: 1.5, backend: B0, stim: stimuli[CAL_STIM] })).img
  const m2 = (await render(rig, cfgU, CAND_BY_ID['M2'], { dpr: 1.5, backend: B0, stim: stimuli[CAL_STIM] })).img
  // The M0-rms noise control (0.33 codes on this stimulus) MEASURED 1.053x on the
  // band — below a 15% threshold, because 0.33 codes of grain is genuinely small
  // next to the band's own high-frequency content. That is the metric's floor, not
  // a failure, so it is reported and a 2-code noise control (about 7% of the flat
  // stimulus's whole 30-code span, i.e. plainly visible) is the known-bad.
  const kbNoise2 = addWhiteNoise(gt64, 2.0, 555)
  const grainControls: Array<{ id: string; img: FloatImg; cls: 'kg' | 'kb' | 'report' }> = [
    { id: 'GT32', img: gt32, cls: 'kg' },
    { id: 'M1-N16', img: m1x, cls: 'kg' },
    { id: 'white noise @2.0 codes (visible grain)', img: kbNoise2, cls: 'kb' },
    { id: 'M0 (aliasing IS excess HF)', img: m0, cls: 'kb' },
    { id: `white noise @M0 rms (${noiseRms.toFixed(3)} codes) — the FLOOR`, img: kgNoise, cls: 'report' },
    { id: 'M4-N4 jittered', img: m4, cls: 'report' },
    { id: 'M2 unconditional RGSS', img: m2, cls: 'report' },
  ]
  const grainRows: Record<string, { whole: number; band: number; cls: string }> = {}
  for (const c of grainControls) {
    grainRows[c.id] = {
      whole: grainRatio(c.img, gt64, GRAIN_SIGMA, MARGIN).ratio,
      band: grainRatio(c.img, gt64, GRAIN_SIGMA, MARGIN, bandAdaptive.mask).ratio,
      cls: c.cls,
    }
  }
  results.grain = { sigmaPx: GRAIN_SIGMA, threshold: grainThresh, rows: grainRows }
  for (const c of grainControls) {
    const r = grainRows[c.id]
    if (c.cls === 'report') {
      console.log(`  note  grainRatio (reported, not a gate) ${c.id.padEnd(28)} whole-frame ${r.whole.toFixed(4)}x  band ${r.band.toFixed(4)}x  ` +
        `${Math.abs(1 - r.band) > grainThresh ? 'fires on the band' : 'below the 15% threshold on both'}`)
      continue
    }
    addCal('grainRatio(band)', c.id, c.cls === 'kb' ? 'known-bad' : 'known-good', r.band, 'x', Math.abs(1 - r.band) > grainThresh)
  }

  // -- temporal crawl ------------------------------------------------------
  {
    // A 0.25 px pan of the FLAT stimulus MEASURED only 0.077 codes/frame of true
    // motion — below the 8-bit write, so every candidate read the same 0.133 and
    // the metric had no signal at all. Pans are 0.5 px and the gated stimulus is
    // hicon; flat is still measured and reported, because "the user's scene barely
    // moves under sub-pixel motion" is itself a result.
    const PANS = [0, 0.5, 1.0, 1.5]
    const frames = async (cand: Candidate, s: StimId): Promise<FloatImg[]> => {
      const out: FloatImg[] = []
      for (const p of PANS) out.push((await render(rig, cfgU, cand, { dpr: 1.5, backend: B0, stim: shiftRgba8(stimuli[s], p, 0) })).img)
      return out
    }
    const temporalThresh = 0.5 // codes of EXCESS frame-to-frame change — a FLOOR
    const tRows: Record<string, Record<string, ReturnType<typeof temporalExcess>>> = {}
    const tThresh: Record<string, number> = {}
    for (const s of ['hicon', 'flat'] as StimId[]) {
      const fGt = await frames(CAND_BY_ID['M6-GT16'], s)
      const fM0 = await frames(CAND_BY_ID['M0'], s)
      const fM1 = await frames(CAND_BY_ID['M1-N16'], s)
      const fM4 = await frames(CAND_BY_ID['M4-N4'], s)
      // A 0.33-code independent noise MEASURED 1.42 codes of excess — about the
      // same as a real 16-tap fix's residual instability (1.14). That is a
      // finding, not a calibration control: it says a stochastic candidate's
      // crawl on this content sits at the level of a good deterministic one's
      // residual. The known-bad is therefore 2-code noise, plainly visible.
      const noiseFrames = fGt.map((f, i) => addWhiteNoise(f, 2.0, 1000 + i * 37))
      const weakNoiseFrames = fGt.map((f, i) => addWhiteNoise(f, noiseRms, 4000 + i * 37))
      const tmask = bandFromControl(fM0[0], fGt[0], MARGIN, 0.03, 1.0).mask
      tRows[s] = {
        'KG GT16 vs itself': temporalExcess(fGt, fGt, tmask, MARGIN),
        'KG M1-N16': temporalExcess(fM1, fGt, tmask, MARGIN),
        'KB M0 1 tap': temporalExcess(fM0, fGt, tmask, MARGIN),
        'KB per-frame independent noise @2.0 codes': temporalExcess(noiseFrames, fGt, tmask, MARGIN),
        'REPORT M4-N4 jittered': temporalExcess(fM4, fGt, tmask, MARGIN),
        'REPORT independent noise @M0 rms': temporalExcess(weakNoiseFrames, fGt, tmask, MARGIN),
      }
      // The threshold is RELATIVE to the reference's own frame-to-frame motion.
      // A fixed 0.5 codes was tried and MEASURED wrong: on hicon the reference
      // itself moves 2.37 codes/frame, so 0.5 codes of excess is well inside the
      // noise of a legitimate candidate (M1-N16 read 1.14 and would have failed).
      const gtMotion = tRows[s]['KB M0 1 tap'].gtMotionMean
      const thr = Math.max(temporalThresh, gtMotion)
      tThresh[s] = thr
      for (const [k, v] of Object.entries(tRows[s])) {
        if (k.startsWith('REPORT')) {
          console.log(`  note  temporalExcess ${s} (reported) ${k.slice(7).padEnd(32)} ${v.excessMean.toFixed(4)} codes (GT motion ${v.gtMotionMean.toFixed(3)}, threshold ${thr.toFixed(3)})`)
          continue
        }
        if (s !== 'hicon') {
          console.log(`  note  temporalExcess flat (reported, ~no signal) ${k.padEnd(38)} ${v.excessMean.toFixed(4)} codes (GT motion ${v.gtMotionMean.toFixed(3)})`)
          continue
        }
        addCal('temporalExcess', `${k.slice(3)} [hicon]`, k.startsWith('KB') ? 'known-bad' : 'known-good', v.excessMean, 'codes', v.excessMean > thr)
      }
    }
    results.temporal = {
      pansPx: PANS, thresholdFloor: temporalThresh, thresholdUsed: tThresh, gatedStimulus: 'hicon', rows: tRows,
      note: "threshold = max(0.5 codes, the reference's own mean frame-to-frame motion). Flat is measured but not gated: a 0.5-1.5 px pan of a 30-code-span source moves the reference only 0.127 codes/frame, so there is no temporal signal to grade there — itself a result.",
    }
    const h = tRows.hicon
    const kgWorst = Math.max(h['KG GT16 vs itself'].excessMean, h['KG M1-N16'].excessMean)
    const kbBest = Math.min(h['KB M0 1 tap'].excessMean, h['KB per-frame independent noise @2.0 codes'].excessMean)
    add('V7-temporal', 'the temporal metric is exactly zero on the reference and separates the 1-tap control from a real fix',
      `hicon: GT vs itself ${h['KG GT16 vs itself'].excessMean.toFixed(6)}, M1-N16 ${h['KG M1-N16'].excessMean.toFixed(3)}, M0 ${h['KB M0 1 tap'].excessMean.toFixed(3)} codes ` +
      `(GT own motion ${h['KB M0 1 tap'].gtMotionMean.toFixed(3)} codes/frame, threshold ${tThresh.hicon.toFixed(3)}), separation ${(kbBest / Math.max(kgWorst, 1e-9)).toFixed(1)}x; ` +
      `flat: GT motion only ${tRows.flat['KB M0 1 tap'].gtMotionMean.toFixed(3)} codes/frame — no signal, reported not gated`,
      'GT-vs-itself == 0 exactly and the best known-bad at least 2x the worst known-good on hicon',
      h['KG GT16 vs itself'].excessMean === 0 && kbBest >= 2 * kgWorst)
  }

  // -- cost ---------------------------------------------------------------
  {
    const cost: Array<Record<string, unknown>> = []
    for (const backend of backends) {
      for (const cid of ['defaults', 'user']) {
        for (const cand of CANDIDATES) {
          if (cand.family === 'M6' && cand.grid && cand.grid.n > 8) continue
          const c = await renderCount(rig, CFG_BY_ID[cid].cfg, cand, { dpr: 1.5, backend, stim: stimuli.flat })
          cost.push({ backend, cfg: cid, cand: cand.id, nominal: cand.nominalFetches, ...c })
        }
      }
    }
    results.cost = cost
    const find = (cfg: string, cand: string): Record<string, unknown> =>
      cost.find((c) => c.cfg === cfg && c.cand === cand && c.backend === B0)!
    // At the defaults a gated candidate falls through to the UNTOUCHED shipped
    // shader, which costs 1 fetch normally and 2 where its own seam split fires.
    // So the cost no-op is "identical to M0", not "exactly 1".
    const dm0 = find('defaults', 'M0')
    const dad = find('defaults', 'M1-adapt8')
    const uad = find('user', 'M1-adapt8')
    const same = dm0.mean === dad.mean && dm0.min === dad.min && dm0.max === dad.max
    add('V7-cost', "fetch counting is real: at the defaults the adaptive candidate costs EXACTLY what M0 costs, and more on the user's config",
      `defaults M0 mean ${(dm0.mean as number).toFixed(4)} [${dm0.min},${dm0.max}] vs M1-adapt8 mean ${(dad.mean as number).toFixed(4)} [${dad.min},${dad.max}]; user M1-adapt8 mean ${(uad.mean as number).toFixed(4)} [${uad.min},${uad.max}] fetches/fragment`,
      'identical distribution to M0 at the defaults (max 2 = the shipped seam split), and user mean > 1', same && (uad.mean as number) > 1)
    const un = find('defaults', 'M2')
    add('V7-cost-kb', 'cost metric SEES an unconditional 4-tap candidate at the defaults',
      `M2 at defaults mean ${(un.mean as number).toFixed(3)} [${un.min},${un.max}]`,
      'min == max == 4', un.min === 4 && un.max === 4)
  }

  // -- GPU time -------------------------------------------------------------
  {
    const timing: Array<Record<string, unknown>> = []
    for (const cid of ['M0', 'M1-N4', 'M1-adapt8', 'M2', 'M6-GT8']) {
      for (const backend of backends) {
        const r = await render(rig, cfgU, CAND_BY_ID[cid], { dpr: 1.5, backend, stim: stimuli.flat, timeRepeats: 40 })
        timing.push({ cand: cid, backend, nsPerDraw: r.gpuNs, method: r.timing })
      }
    }
    results.gpuTime = { rows: timing, hasTimestamp: rig.hasTimestamp }
    const g = (cid: string): number | null =>
      (timing.find((t) => t.cand === cid && t.backend === B0)?.nsPerDraw ?? null) as number | null
    const m0ns = g('M0')
    const gt8ns = g('M6-GT8')
    const ok = m0ns != null && gt8ns != null && gt8ns > 2 * m0ns
    add('V7-time', 'GPU timing is available and orders a 1-tap against a 64-tap correctly',
      timing.filter((t) => t.backend === B0).map((t) => `${t.cand} ${t.nsPerDraw == null ? 'n/a' : `${((t.nsPerDraw as number) / 1000).toFixed(1)}us`}`).join(' ') +
      ` (method ${timing[0]?.method})`,
      'a 64-tap GT costs more than 2x a 1-tap control, else timing is not resolving and cost is reported as fetch counts only', ok)
  }

  // -----------------------------------------------------------------------
  // Plates
  // -----------------------------------------------------------------------
  {
    const cw = 44
    const ch = 80
    const x0 = Math.max(0, Math.min(W - cw, trackWin.x0 - 6))
    const y0 = Math.max(0, Math.min(H - ch, trackWin.y0))
    const cols = [
      { label: 'M0', img: m0 },
      { label: 'M1-N16', img: m1x },
      { label: 'M3-C1', img: m3 },
      { label: 'M5', img: m5 },
      { label: 'GT64', img: gt64 },
    ]
    const p1 = writePng('p14min-calib-seam-6x-luma-M0_M1N16_M3C1_M5_GT64.png', seamPlateLuma(cols, 4, x0, y0, cw, ch, 6))
    const p2 = writePng('p14min-calib-seam-6x-diff8x-M0_M1N16_M3C1_M5_GT64.png', seamPlateDiff(cols, gt64, x0, y0, cw, ch, 6, 8))
    // full frames too, so the crop can be located
    const p3 = writePng('p14min-calib-full-M0.png', toRgba8(m0))
    const p4 = writePng('p14min-calib-full-GT64.png', toRgba8(gt64))
    results.plates = {
      seam6xLuma: p1, seam6xDiff8x: p2, fullM0: p3, fullGT64: p4,
      columns: cols.map((c) => c.label), crop: { x0, y0, cw, ch }, zoom: 6,
      note: 'luma plate: all columns share the GT crop\'s p1-p99 linear map. diff plate: red = candidate brighter than GT, blue = darker, 8x amplified.',
    }
    console.log(`  plate ${p1}\n  plate ${p2}`)
  }

  results.gates = gates
  const failed = gates.filter((g) => !g.pass)
  const calFailed = cal.filter((c) => !c.ok)
  results.calibration = cal
  console.log(`\n  gates: ${gates.length - failed.length}/${gates.length} pass` + (failed.length ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ''))
  console.log(`  metric calibration: ${cal.length - calFailed.length}/${cal.length} pass` +
    (calFailed.length ? ` — FAILED: ${calFailed.map((c) => `${c.metric}/${c.control}`).join(', ')}` : ''))
}

// ===========================================================================
// The sweep (--sweep) — built, deliberately not run in this pass
// ===========================================================================

/**
 * The full matrix. Two cost decisions, both stated rather than hidden:
 *
 *  - THE SWEEP'S REFERENCE IS GT32, NOT GT64. V4a measured |GT32 - GT64| at
 *    0.037 codes rmse on the flat stimulus and 0.084 on the high-contrast one,
 *    against candidate separations of tenths of a code — so GT32 is inside the
 *    resolution the ranking needs, at a quarter of the draws (16 tiles vs 64).
 *    GT64 is still rendered for the decisive cases and the plates.
 *  - THE REFERENCE IS RENDERED ON THE PRIMARY BACKEND ONLY. V4b measured
 *    |GT32(webgpu) - GT32(webgl2)| at 0.001 codes rmse, so one reference serves
 *    both backends and any candidate's cross-backend delta is the candidate's.
 */
interface SweepRow {
  cfg: string
  stimulus: StimId
  backend: Backend
  dpr: number
  cand: string
  bandPx: number
  bandTheta: number
  errBand: Resid
  errAll: Resid
  look: LookResult
  grainBand: number
  /** cross-rib caustic contrast, candidate / reference. 1.000 = preserved. */
  caustic: number | null
  /** tracked-contour lateral jitter, px. null where the reference itself does not
   *  track cleanly in this cell — a jitter number measured there would grade the
   *  estimator, not the candidate. */
  jumpP95: number | null
  /** contour raggedness, mean |2nd difference|, px */
  jump2nd: number | null
  /** peak cross-rib gradient at the tracked contour, codes/px */
  peakCodes: number | null
  /** max/mean |this backend - the other backend| for the SAME candidate, codes */
  parityMax: number | null
  parityMean: number | null
  fetches: { mean: number; min: number; max: number } | null
  gpuNsPerDraw: number | null
  timingMethod: string
}

interface SweepCell {
  cfg: string
  stimulus: StimId
  dpr: number
  bandPx: number
  bandTheta: number
  causticWindow: { x0: number; x1: number; y0: number; y1: number }
  causticGtCodes: number
  jitterWindow: { x0: number; x1: number; seed: number; sigma: number } | null
  jitterGtPx: number | null
  jitterThreshPx: number | null
  jitterTrueSlopePxPerRow: number
  jitterQualifies: boolean
}

/** The sine rib's geometric lateral slope, px per row — the floor any real
 *  contour tracker must be allowed. Straight ribs are exactly vertical. */
function trueSlopePxPerRow(cfg: ReedCfg): number {
  if (cfg.ribType !== 'wave' || cfg.waveShape !== 'sine') return 0
  const amp = cfg.amplitude ?? 0
  const wl = cfg.wavelength ?? 1
  return (2 * Math.PI * amp) / Math.max(wl, 1e-6)
}

/**
 * Pick the jitter-tracking window the same way the calibration does — TWO
 * conditions, because optimising only for "the reference tracks smoothest" finds
 * a window where nothing is wrong and the known-bad stops being bad:
 *   1. the window must be in the top quartile of error-band density (the artefact
 *      must be present), and
 *   2. the CONVERGED REFERENCE's own tracked contour must come within 3x the
 *      rib's geometric lateral slope.
 * Smallest smoothing sigma that lets the reference qualify wins, because
 * smoothing is what erases the jitter being measured. Returns null when no
 * window qualifies — the metric is then reported as unavailable in that cell
 * rather than reported wrong.
 */
function pickJitterWindow(
  gt: FloatImg, band: Uint8Array, yBand: { y0: number; y1: number }, trueSlope: number,
): { x0: number; x1: number; seed: number; sigma: number; gtJump: number; dens: number } | null {
  const ceiling = Math.max(3 * trueSlope, 0.30)
  const lGt = lumaF(gt)
  const dens = (x0: number, x1: number): number => {
    let n = 0
    for (let y = yBand.y0; y < yBand.y1; y++) for (let x = x0; x < x1; x++) n += band[y * W + x]
    return n
  }
  const wins: Array<{ x0: number; x1: number; dens: number }> = []
  for (let cx = MARGIN + 22; cx < W - MARGIN - 22; cx += 2) wins.push({ x0: cx - 20, x1: cx + 20, dens: dens(cx - 20, cx + 20) })
  const sorted = [...wins].map((w) => w.dens).sort((a, b) => a - b)
  const q75 = sorted[Math.floor(sorted.length * 0.75)]
  const artefactWins = wins.filter((w) => w.dens >= q75 && w.dens > 0)
  for (const sig of [0, 0.5, 1.0]) {
    const lSm = gaussBlur(lGt, W, H, sig)
    let pick: { x0: number; x1: number; seed: number; sigma: number; gtJump: number; dens: number } | null = null
    for (const c of artefactWins) {
      const sd = trackSeed(lSm, W, c.x0, c.x1, yBand.y0)
      const gj = seamTrack(lGt, W, c.x0, c.x1, yBand.y0, yBand.y1, { seed: sd, radius: 2, smoothSigma: sig, height: H }).jumpP95
      if (gj > ceiling) continue
      if (!pick || c.dens > pick.dens) pick = { x0: c.x0, x1: c.x1, seed: sd, sigma: sig, gtJump: gj, dens: c.dens }
    }
    if (pick) return pick
  }
  return null
}

async function runSweep(rig: AaRig, backends: Backend[], cfgFilter: string[] | null): Promise<void> {
  const stimuli = await loadStimuli(rig)
  const rows: SweepRow[] = []
  const cells: SweepCell[] = []
  const shippable = CANDIDATES.filter((c) => c.family !== 'M6' && !c.probe)
  // GT8 / GT16 ride along as IN-SWEEP known-good controls: if a gate fires on
  // them, the gate is broken, not the candidate. Primary backend only.
  const gtControls = ['M6-GT8', 'M6-GT16']
  const lookSigma = (results.look as { chosenSigmaPx?: number } | undefined)?.chosenSigmaPx ?? LOOK_SIGMA
  const configs = cfgFilter ? CONFIGS.filter((c) => cfgFilter.includes(c.id)) : CONFIGS
  const t0 = Date.now()
  let nCell = 0
  const totalCells = configs.length * 3 * DPRS.length
  for (const cfg of configs) {
    const trueSlope = trueSlopePxPerRow(cfg.cfg)
    for (const stim of ['flat', 'hicon', 'step'] as StimId[]) {
      // one reference per (cfg, stimulus, dpr), on the primary backend
      for (const dpr of DPRS) {
        const gt = (await render(rig, cfg.cfg, CAND_BY_ID['M6-GT32'], { dpr, backend: backends[0], stim: stimuli[stim] })).img
        const ctrl = (await render(rig, cfg.cfg, CAND_BY_ID['M0'], { dpr, backend: backends[0], stim: stimuli[stim] })).img
        const band = bandFromControl(ctrl, gt, MARGIN, 0.03, 1.0)
        // Both windows come from the REFERENCE and the CONTROL only, so no
        // candidate can move them.
        const cwin = pickTrackWindow(gt, band.mask)
        const lGt = lumaF(gt)
        const ccGt = causticContrast(lGt, W, H, cwin.x0, cwin.x1, cwin.y0, cwin.y1)
        const jwin = pickJitterWindow(gt, band.mask, { y0: cwin.y0, y1: cwin.y1 }, trueSlope)
        cells.push({
          cfg: cfg.id, stimulus: stim, dpr, bandPx: band.count, bandTheta: band.theta,
          causticWindow: cwin, causticGtCodes: ccGt.median,
          jitterWindow: jwin ? { x0: jwin.x0, x1: jwin.x1, seed: jwin.seed, sigma: jwin.sigma } : null,
          jitterGtPx: jwin ? jwin.gtJump : null,
          jitterThreshPx: jwin ? 3 * jwin.gtJump : null,
          jitterTrueSlopePxPerRow: trueSlope,
          jitterQualifies: jwin != null,
        })
        const measure = (img: FloatImg): Pick<SweepRow, 'errBand' | 'errAll' | 'look' | 'grainBand' | 'caustic' | 'jumpP95' | 'jump2nd' | 'peakCodes'> => {
          const l = lumaF(img)
          const cc = causticContrast(l, W, H, cwin.x0, cwin.x1, cwin.y0, cwin.y1)
          const st = jwin
            ? seamTrack(l, W, jwin.x0, jwin.x1, cwin.y0, cwin.y1, { seed: jwin.seed, radius: 2, smoothSigma: jwin.sigma, height: H })
            : null
          return {
            errBand: residual(img, gt, MARGIN, band.mask),
            errAll: residual(img, gt, MARGIN),
            look: lookDelta(img, gt, lookSigma, MARGIN),
            grainBand: grainRatio(img, gt, GRAIN_SIGMA, MARGIN, band.mask).ratio,
            caustic: ccGt.median > 1e-9 ? cc.median / ccGt.median : null,
            jumpP95: st ? st.jumpP95 : null,
            jump2nd: st ? st.curvature2nd : null,
            peakCodes: st ? st.meanPeakCodes : null,
          }
        }
        // Candidates: render on EVERY backend before scoring, so the
        // cross-backend delta is measured on the same pixels.
        for (const cand of shippable) {
          const imgs: Partial<Record<Backend, FloatImg>> = {}
          const meta: Partial<Record<Backend, { gpuNs: number | null; timing: string; fetches: { mean: number; min: number; max: number } }>> = {}
          for (const backend of backends) {
            const r = await render(rig, cfg.cfg, cand, { dpr, backend, stim: stimuli[stim], timeRepeats: 20 })
            const fetches = await renderCount(rig, cfg.cfg, cand, { dpr, backend, stim: stimuli[stim] })
            imgs[backend] = r.img
            meta[backend] = { gpuNs: r.gpuNs, timing: r.timing, fetches }
          }
          const par = backends.length === 2 ? residual(imgs[backends[0]]!, imgs[backends[1]]!, MARGIN) : null
          for (const backend of backends) {
            rows.push({
              cfg: cfg.id, stimulus: stim, backend, dpr, cand: cand.id,
              bandPx: band.count, bandTheta: band.theta,
              ...measure(imgs[backend]!),
              parityMax: par ? par.max : null,
              parityMean: par ? par.mean : null,
              fetches: meta[backend]!.fetches,
              gpuNsPerDraw: meta[backend]!.gpuNs,
              timingMethod: meta[backend]!.timing,
            })
          }
        }
        for (const gid of gtControls) {
          const r = await render(rig, cfg.cfg, CAND_BY_ID[gid], { dpr, backend: backends[0], stim: stimuli[stim] })
          rows.push({
            cfg: cfg.id, stimulus: stim, backend: backends[0], dpr, cand: gid,
            bandPx: band.count, bandTheta: band.theta,
            ...measure(r.img),
            parityMax: null, parityMean: null, fetches: null,
            gpuNsPerDraw: r.gpuNs, timingMethod: r.timing,
          })
        }
        nCell++
        const el = (Date.now() - t0) / 1000
        console.log(`  sweep ${cfg.id}/${stim}/dpr${dpr}: ${shippable.length * backends.length + gtControls.length} rows, ` +
          `band ${band.count} px @theta ${band.theta.toFixed(2)}, ` +
          `jitter ${jwin ? `x[${jwin.x0},${jwin.x1}] gt ${jwin.gtJump.toFixed(3)}px sig${jwin.sigma}` : 'UNAVAILABLE (reference does not track)'} ` +
          `[${nCell}/${totalCells}, ${el.toFixed(0)}s elapsed, eta ${((el / nCell) * (totalCells - nCell)).toFixed(0)}s]`)
      }
    }
  }
  results.sweep = { rows, cells, referenceLevel: 32, referenceBackend: backends[0], lookSigmaPx: lookSigma }
}

/**
 * Error stratified by the MEASURED per-pixel |L'|.
 *
 * The sweep's band average mixes |L'| = 0.4 pixels with |L'| = 200 pixels in the
 * same number, so it cannot answer "how many taps does |L'| = 175.9 need". This
 * renders the node's own predicate as a field, buckets the frame by it, and
 * reports each candidate's residual per bucket. GT8/GT16 ride along as the
 * known-good floor in every bucket.
 */
const LP_BUCKETS: Array<[number, number, string]> = [
  [0, 1, '<1 (no minification)'],
  [1, 3, '1-3'],
  [3, 8, '3-8'],
  [8, 30, '8-30'],
  [30, 200, '30-200'],
  [200, Infinity, '>200'],
]

async function runStratified(rig: AaRig, backends: Backend[]): Promise<void> {
  const stimuli = await loadStimuli(rig)
  const B0 = backends[0]
  const cands = [
    'M0', 'M0-nosplit', 'M1-N2', 'M1-N4', 'M1-N8', 'M1-N16', 'M1-N32', 'M1-N64',
    'M1-N8w', 'M1-N16w', 'M1-N8x2', 'M1-N16x2', 'M1-adapt8', 'M1-src16',
    'M2', 'M3-C4', 'M4-N8', 'M7-N3', 'M6-GT8', 'M6-GT16',
  ]
  const outAll: Record<string, unknown> = {}
  for (const cid of ['user', 'c150']) {
    const cfg = CFG_BY_ID[cid].cfg
    const g = graphFor(cfg)
    for (const stim of ['flat', 'hicon'] as StimId[]) {
      const lp = decodeLpField((await rig.run({
        backend: B0, width: W, height: H, dpr: 1.5,
        passes: lpFieldPasses(g), images: { [g.imageSampler]: stimuli[stim] },
      })).image)
      const gt = (await render(rig, cfg, CAND_BY_ID['M6-GT32'], { dpr: 1.5, backend: B0, stim: stimuli[stim] })).img
      const masks = LP_BUCKETS.map(([lo, hi]) => {
        const m = new Uint8Array(W * H)
        let n = 0
        for (let y = MARGIN; y < H - MARGIN; y++) {
          for (let x = MARGIN; x < W - MARGIN; x++) {
            const i = y * W + x
            if (lp[i] >= lo && lp[i] < hi) { m[i] = 1; n++ }
          }
        }
        return { m, n }
      })
      const rows: Array<Record<string, unknown>> = []
      for (const c of cands) {
        const img = (await render(rig, cfg, CAND_BY_ID[c], { dpr: 1.5, backend: B0, stim: stimuli[stim] })).img
        const per = masks.map((b) => (b.n > 0 ? residual(img, gt, MARGIN, b.m) : null))
        rows.push({
          cand: c,
          buckets: per.map((r, i) => ({
            range: LP_BUCKETS[i][2], px: masks[i].n,
            mean: r ? r.mean : null, rmse: r ? r.rmse : null, max: r ? r.max : null,
          })),
        })
      }
      outAll[`${cid}/${stim}`] = { bucketPx: masks.map((b) => b.n), rows }
      console.log(`  strat ${cid}/${stim}: bucket px ${masks.map((b, i) => `${LP_BUCKETS[i][2]}=${b.n}`).join(' ')}`)
    }
  }
  results.stratified = { buckets: LP_BUCKETS.map((b) => b[2]), byCell: outAll, dpr: 1.5, backend: B0, reference: 'GT32' }
}

/**
 * The plates the ranking is read back from. Every column of a plate shares the
 * GT crop's own p1-p99 map, so a brightness or contrast change shows up rather
 * than being normalised away.
 */
async function runPlates(rig: AaRig, backends: Backend[]): Promise<void> {
  const stimuli = await loadStimuli(rig)
  const B0 = backends[0]
  const cfgU = CFG_BY_ID['user'].cfg
  const out: Record<string, unknown> = {}
  for (const stim of ['flat', 'hicon'] as StimId[]) {
    const gt64 = (await render(rig, cfgU, CAND_BY_ID['M6-GT64'], { dpr: 1.5, backend: B0, stim: stimuli[stim] })).img
    const gt32 = (await render(rig, cfgU, CAND_BY_ID['M6-GT32'], { dpr: 1.5, backend: B0, stim: stimuli[stim] })).img
    const m0 = (await render(rig, cfgU, CAND_BY_ID['M0'], { dpr: 1.5, backend: B0, stim: stimuli[stim] })).img
    const band = bandFromControl(m0, gt64, MARGIN, 0.03, 1.0)
    const win = pickTrackWindow(gt64, band.mask)
    const cw = 44
    const ch = 88
    const x0 = Math.max(0, Math.min(W - cw, win.x0 - 6))
    const y0 = Math.max(0, Math.min(H - ch, win.y0))
    const get = async (id: string): Promise<FloatImg> =>
      (await render(rig, cfgU, CAND_BY_ID[id], { dpr: 1.5, backend: B0, stim: stimuli[stim] })).img
    const plates: Array<{ name: string; ids: string[] }> = [
      { name: 'M1ladder', ids: ['M0', 'M1-N2', 'M1-N4', 'M1-N8', 'M1-N16', 'GT64'] },
      { name: 'adaptive', ids: ['M0', 'M1-adapt4', 'M1-adapt8', 'M1-adapt16', 'M2', 'GT64'] },
      { name: 'M3clamp', ids: ['M0', 'M3-C16', 'M3-C4', 'M3-C1', 'GT64'] },
      { name: 'others', ids: ['M0', 'M7-N3', 'M4-N8', 'M1-src16', 'M5', 'GT64'] },
    ]
    const cache: Record<string, FloatImg> = { GT64: gt64, GT32: gt32, M0: m0 }
    for (const p of plates) {
      const cols: Array<{ label: string; img: FloatImg }> = []
      for (const id of p.ids) {
        if (!cache[id]) cache[id] = await get(id)
        cols.push({ label: id, img: cache[id] })
      }
      const gi = p.ids.length - 1
      const a = writePng(`p14min-sweep-${stim}-${p.name}-6x-luma.png`, seamPlateLuma(cols, gi, x0, y0, cw, ch, 6))
      const b = writePng(`p14min-sweep-${stim}-${p.name}-6x-diff8x.png`, seamPlateDiff(cols, gt64, x0, y0, cw, ch, 6, 8))
      out[`${stim}/${p.name}`] = { luma: a, diff: b, columns: p.ids }
      console.log(`  plate ${a}`)
    }
    // A 12x crop of a NARROW strip. The 6x six-column plate is ~1600 px wide and
    // gets downsampled when read back, which is exactly the resolution the
    // "is the hairline continuous or dashed" question needs. Four columns at 12x
    // keeps every device pixel legible.
    {
      const zids = ['M0', 'M1-N4', 'M1-N8', 'GT64']
      const zcols: Array<{ label: string; img: FloatImg }> = []
      for (const id of zids) { if (!cache[id]) cache[id] = await get(id); zcols.push({ label: id, img: cache[id] }) }
      const zx = Math.max(0, Math.min(W - 22, win.x0 + 8))
      const zy = Math.max(0, Math.min(H - 44, win.y0 + 20))
      const pz = writePng(`p14min-sweep-${stim}-zoom12x-M0_N4_N8_GT64.png`, seamPlateLuma(zcols, 3, zx, zy, 22, 44, 12))
      out[`${stim}/zoom12`] = { luma: pz, columns: zids, crop: { x0: zx, y0: zy, w: 22, h: 44 }, zoom: 12 }
      console.log(`  plate ${pz}`)
    }
    // WHOLE-RIB crops for the MACROSCOPIC look question: the 6x seam crop cannot
    // show a rib-scale flattening, and a 6-column macro plate is illegible. Split
    // into two 3-column plates over the same 1.3-rib-period crop.
    const mx = Math.max(0, Math.min(W - 160, win.x0 - 60))
    const my = Math.max(0, Math.min(H - 200, win.y0))
    const macroSets: Array<{ name: string; ids: string[] }> = [
      { name: 'macroFix', ids: ['M0', 'M1-adapt8', 'GT64'] },
      { name: 'macroClamp', ids: ['M0', 'M3-C4', 'M3-C1'] },
    ]
    for (const s of macroSets) {
      const cols: Array<{ label: string; img: FloatImg }> = []
      for (const id of s.ids) { if (!cache[id]) cache[id] = await get(id); cols.push({ label: id, img: cache[id] }) }
      // Normalised on GT64's crop in BOTH plates, so the two are directly comparable
      // and a contrast change cannot hide inside a per-plate renormalisation.
      // Only append GT64 when the set does not already end with it, else the plate
      // carries a duplicate last column (verified byte-identical, but confusing).
      const withGt = s.ids[s.ids.length - 1] === 'GT64' ? cols : [...cols, { label: 'GT64', img: gt64 }]
      const p = writePng(`p14min-sweep-${stim}-${s.name}-3x-luma.png`,
        seamPlateLuma(withGt, withGt.length - 1, mx, my, 160, 200, 3))
      out[`${stim}/${s.name}`] = { luma: p, columns: [...s.ids, 'GT64'], crop: { x0: mx, y0: my, w: 160, h: 200 }, zoom: 3 }
      console.log(`  plate ${p}`)
    }
    // Row profile through the caustic — the plate that makes "the dark hairline
    // merged into the band" a measurement rather than an impression.
    {
      const prow = my + 100
      // Narrower x window than the macro crop: 160 px at 6 px/sample is 960 px of
      // plot for 1.3 rib periods, and the caustic pair is 2 px wide. 60 px centred
      // on the seam is what actually resolves "one band or two".
      const px0 = Math.max(0, Math.min(W - 60, win.x0 - 6))
      // Two plots, because five overlaid traces hide each other: one for the FIX
      // question and one for the CLAMP question.
      const sets: Array<{ name: string; ids: string[] }> = [
        { name: 'fix', ids: ['M0', 'M1-adapt8', 'GT64'] },
        { name: 'clamp', ids: ['M3-C1', 'M3-C4', 'GT64'] },
      ]
      const made: Record<string, unknown> = {}
      for (const s of sets) {
        for (const id of s.ids) if (!cache[id]) cache[id] = await get(id)
        const p = writePng(`p14min-sweep-${stim}-profile-${s.name}-row${prow}.png`,
          profilePlot(s.ids.map((id) => ({ label: id, l: lumaF(cache[id]) })), prow, px0, px0 + 60))
        made[s.name] = { png: p, series: s.ids, colours: s.ids.map((_, i) => PROFILE_COLOURS[i]) }
        console.log(`  plate ${p}`)
      }
      out[`${stim}/profile`] = { row: prow, x: [px0, px0 + 60], plots: made }
    }
    // Full frames of the decisive three
    for (const id of ['M0', 'M1-adapt8', 'M3-C1', 'GT64']) {
      if (!cache[id]) cache[id] = await get(id)
      out[`${stim}/full/${id}`] = writePng(`p14min-sweep-${stim}-full-${id}.png`, toRgba8(cache[id]))
    }
    out[`${stim}/crop`] = { x0, y0, cw, ch, zoom: 6, bandPx: band.count, bandTheta: band.theta }
  }
  results.sweepPlates = out
}

/**
 * Choose the window on the ARTEFACT: the 120-row span and 40-column window where
 * the error band (M0 vs the converged reference) is densest.
 *
 * The first version picked the column of largest total cross-rib gradient, which
 * landed on a broad bright band rather than the thin caustic pair, and the plate
 * showed no artefact at all. Locating the window from |control - reference| finds
 * where the defect actually is; it is a function of the control and the reference
 * only, so no candidate can move it.
 */
function pickTrackWindow(gt: FloatImg, band: Uint8Array): { x0: number; x1: number; y0: number; y1: number } {
  void gt
  const rowsPerWin = 120
  let by = MARGIN
  let bs = -1
  for (let y = MARGIN; y + rowsPerWin < H - MARGIN; y += 8) {
    let s = 0
    for (let yy = y; yy < y + rowsPerWin; yy++) for (let x = MARGIN; x < W - MARGIN; x++) s += band[yy * W + x]
    if (s > bs) { bs = s; by = y }
  }
  let bx = MARGIN + 20
  let bxs = -1
  for (let x = MARGIN + 20; x < W - MARGIN - 20; x++) {
    let s = 0
    for (let yy = by; yy < by + rowsPerWin; yy++) for (let dx = -3; dx <= 3; dx++) s += band[yy * W + x + dx]
    if (s > bxs) { bxs = s; bx = x }
  }
  return { x0: Math.max(MARGIN, bx - 20), x1: Math.min(W - MARGIN, bx + 20), y0: by, y1: by + rowsPerWin }
}

// ===========================================================================
// Sweep report — the two-sided gate
// ===========================================================================

/**
 * The verdict is TWO-SIDED and the two sides are not interchangeable:
 *   ERROR side  — errBand mean must drop below the calibrated 0.5-code threshold
 *                 (and the corroborating jitter must drop below 3x the reference's)
 *   LOOK  side  — lookDelta(norm) must stay under 3x the worst known-good AND the
 *                 caustic's own cross-rib contrast must stay within the calibrated
 *                 band of the reference's.
 * A candidate that wins the error side and trips the look side is reported as a
 * LOOK CHANGE, never as a winner.
 */
type Verdict = 'clean' | 'partial' | 'no-improvement' | 'look-change' | 'reference' | 'band-empty'

/** Below this the band has too few pixels to average, and `residual` over an
 *  empty mask returns all zeros — which must never be read as "perfect". */
const MIN_BAND_PX = 200

function verdictOf(
  r: SweepRow, thr: { err: number; look: number; caustic: number | null }, ctrlErr: number,
): Verdict {
  if (r.cand.startsWith('M6-')) return 'reference'
  const lookBad = r.look.norm > thr.look
  const ccBad = thr.caustic != null && r.caustic != null && Math.abs(1 - r.caustic) > thr.caustic
  if (lookBad || ccBad) return 'look-change'
  // The error side cannot be judged where there is no error: at the node defaults
  // on the flat stimulus, |M0 - GT| never reaches 1 code anywhere, so the band is
  // empty and every errBand reads 0.000 by construction.
  if (r.bandPx < MIN_BAND_PX) return 'band-empty'
  if (r.errBand.mean <= thr.err) return 'clean'
  if (r.errBand.mean <= 0.6 * ctrlErr) return 'partial'
  return 'no-improvement'
}

const F = (v: number | null | undefined, d = 3): string => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d))

function writeSweepReport(L: string[]): void {
  const sw = results.sweep as { rows: SweepRow[]; cells: SweepCell[]; referenceLevel: number; referenceBackend: Backend; lookSigmaPx: number } | undefined
  if (!sw || !sw.rows.length) return
  const lookThr = (results.look as { threshold: number }).threshold
  const ccInfo = results.causticContrast as { usable: boolean; threshold: number } | undefined
  const ccThr = ccInfo?.usable ? ccInfo.threshold : null
  const ERR_THR = 0.5
  const B0 = sw.referenceBackend
  const rowsOf = (cfg: string, stim: StimId, dpr: number, backend: Backend): SweepRow[] =>
    sw.rows.filter((r) => r.cfg === cfg && r.stimulus === stim && r.dpr === dpr && r.backend === backend)
  const cellOf = (cfg: string, stim: StimId, dpr: number): SweepCell | undefined =>
    sw.cells.find((c) => c.cfg === cfg && c.stimulus === stim && c.dpr === dpr)

  L.push('# THE SWEEP')
  L.push('')
  L.push(`Reference: **GT${sw.referenceLevel}** on ${B0}. Look sigma ${sw.lookSigmaPx} px. ` +
    `Thresholds from the calibration above: errBand mean **${ERR_THR} codes**, ` +
    `lookDelta(norm) **${lookThr.toFixed(5)}**, ` +
    `caustic |1-ratio| **${ccThr == null ? 'metric dropped' : ccThr.toFixed(4)}**, ` +
    'jitter **3x the reference\'s own tracked jump, per cell**.')
  L.push('')
  L.push('`clean` = error side passes AND look side passes. `look-change` = look side trips, ' +
    'whatever the error side says. `partial` = error improves >40% but not to threshold. ' +
    '`no-improvement` = error within 40% of the control.')
  L.push('')

  const tableFor = (cfg: string, stim: StimId, dpr: number, backend: Backend, title: string): void => {
    const rs = rowsOf(cfg, stim, dpr, backend)
    if (!rs.length) return
    const cell = cellOf(cfg, stim, dpr)
    const ctrl = rs.find((r) => r.cand === 'M0')
    const ctrlErr = ctrl?.errBand.mean ?? Infinity
    L.push(`### ${title}`)
    L.push('')
    if ((cell?.bandPx ?? 0) < MIN_BAND_PX) {
      L.push(`**Error band is ${cell?.bandPx ?? 0} px — below the ${MIN_BAND_PX} px minimum, so every \`errBand\` in this ` +
        'table is the empty-mask zero and carries NO information. Read `errAll` and the look columns instead.**')
      L.push('')
    }
    L.push(`band ${cell?.bandPx ?? '?'} px @theta ${F(cell?.bandTheta, 2)} codes; ` +
      `caustic window x[${cell?.causticWindow.x0},${cell?.causticWindow.x1}] y[${cell?.causticWindow.y0},${cell?.causticWindow.y1}], ` +
      `reference cross-rib contrast ${F(cell?.causticGtCodes, 2)} codes; ` +
      (cell?.jitterQualifies
        ? `jitter window x[${cell.jitterWindow!.x0},${cell.jitterWindow!.x1}] sigma ${cell.jitterWindow!.sigma}, reference ${F(cell.jitterGtPx)} px, threshold ${F(cell.jitterThreshPx)} px`
        : `jitter UNAVAILABLE (no artefact-bearing window gets the reference under ${F(Math.max(3 * (cell?.jitterTrueSlopePxPerRow ?? 0), 0.3))} px)`))
    L.push('')
    L.push('| candidate | fetches/frag | errBand mean | errBand max | errAll mean | look norm | caustic x | jumpP95 px | 2nd diff px | peak c/px | grain x | us/draw | verdict |')
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const r of rs) {
      const v = verdictOf(r, { err: ERR_THR, look: lookThr, caustic: ccThr }, ctrlErr)
      const f = r.fetches ? `${F(r.fetches.mean, 3)} [${r.fetches.min},${r.fetches.max}]` : '—'
      L.push(`| ${r.cand} | ${f} | ${F(r.errBand.mean)} | ${F(r.errBand.max, 1)} | ${F(r.errAll.mean)} | ` +
        `${F(r.look.norm, 5)} | ${F(r.caustic, 4)} | ${F(r.jumpP95)} | ${F(r.jump2nd)} | ${F(r.peakCodes, 2)} | ` +
        `${F(r.grainBand, 3)} | ${r.gpuNsPerDraw == null ? '—' : (r.gpuNsPerDraw / 1000).toFixed(2)} | ${v} |`)
    }
    L.push('')
  }

  L.push("## The decisive cells — the user's exact config (curvature 2.15, ior 1.65, bow 2.72)")
  L.push('')
  tableFor('user', 'flat', 1.5, B0, `user / flat (30-code span, the user's content) / dpr 1.5 / ${B0}`)
  tableFor('user', 'flat', 2, B0, `user / flat / dpr 2 / ${B0}`)
  tableFor('user', 'hicon', 1.5, B0, `user / hicon (226-code span, sanity check) / dpr 1.5 / ${B0}`)
  tableFor('user', 'step', 1.5, B0, `user / step (255-code synthetic edge, the ceiling) / dpr 1.5 / ${B0}`)

  L.push('## The no-op config — node defaults (0% of the rib minifies)')
  L.push('')
  tableFor('defaults', 'flat', 1.5, B0, `defaults / flat / dpr 1.5 / ${B0}`)
  tableFor('defaults', 'hicon', 1.5, B0, `defaults / hicon / dpr 1.5 / ${B0}`)

  L.push('## Every config, flat stimulus, dpr 1.5 — errBand mean (codes)')
  L.push('')
  {
    const cands = [...new Set(sw.rows.filter((r) => r.backend === B0).map((r) => r.cand))]
    const cfgs = [...new Set(sw.rows.map((r) => r.cfg))]
    L.push('| candidate | ' + cfgs.join(' | ') + ' |')
    L.push('|---' + cfgs.map(() => '|---').join('') + '|')
    for (const c of cands) {
      const cells2 = cfgs.map((cid) => {
        const r = rowsOf(cid, 'flat', 1.5, B0).find((x) => x.cand === c)
        return r ? F(r.errBand.mean) : '—'
      })
      L.push(`| ${c} | ${cells2.join(' | ')} |`)
    }
    L.push('')
    L.push('Same cells, lookDelta(norm) — anything above the threshold is a look change:')
    L.push('')
    L.push('| candidate | ' + cfgs.join(' | ') + ' |')
    L.push('|---' + cfgs.map(() => '|---').join('') + '|')
    for (const c of cands) {
      const cells2 = cfgs.map((cid) => {
        const r = rowsOf(cid, 'flat', 1.5, B0).find((x) => x.cand === c)
        return r ? (r.look.norm > lookThr ? `**${F(r.look.norm, 5)}**` : F(r.look.norm, 5)) : '—'
      })
      L.push(`| ${c} | ${cells2.join(' | ')} |`)
    }
    L.push('')
  }

  // WHY M3-C16 measures inert, in closed form. This is not a bug in the patch: it
  // is the arithmetic of the node's own `curvature` clamp.
  L.push("## M3 slope-clamp REACHABILITY — which clamp targets the patch can even express")
  L.push('')
  L.push("The node clamps `k = min(clamp(curvature,0.01,1), 0.99)`, so the smallest value it ever passes to " +
    "`sqrt(max(1 - k^2 x^2, floor))` is `1 - k^2`. The patch raises that floor to `eps = (A/(1+C))^2`, " +
    "so it is INERT unless `eps > 1 - k^2`. The strongest clamp it can express is therefore " +
    "`C_min = A/sqrt(1-k^2) - 1`, which is EXACTLY `|L(1) - L(0)|` — the rib-to-rib displacement, " +
    'i.e. the theoretical floor for any profile with the same macroscopic mapping. The patch reaches that ' +
    'bound and not one step further, which is a structural property rather than a coincidence.')
  L.push('')
  L.push("| config | k | A | 1-k^2 | sup\\|L'\\| | C_min reachable | eps(C=1) | eps(C=4) | eps(C=16) | bites at C=1 / 4 / 16 |")
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const c of CONFIGS) {
    const ior = c.cfg.ior ?? 1.5
    const cv = c.cfg.curvature ?? 0.8
    const { k, A } = lensKA(ior, cv)
    const omk = 1 - k * k
    const cmin = A / Math.sqrt(omk) - 1
    const e = (C: number): number => ((A / (1 + C)) ** 2)
    L.push(`| ${c.id} | ${k.toFixed(3)} | ${A.toFixed(4)} | ${omk.toFixed(5)} | ${supLensDeriv(ior, cv).toFixed(3)} | ` +
      `${cmin.toFixed(3)} | ${e(1).toFixed(5)} | ${e(4).toFixed(5)} | ${e(16).toFixed(5)} | ` +
      `${[1, 4, 16].map((C) => (e(C) > omk ? 'yes' : 'NO')).join(' / ')} |`)
  }
  L.push('')
  {
    const { k, A } = lensKA(1.65, 2.15)
    const frac = (C: number): number => {
      const eps = (A / (1 + C)) ** 2
      const t = Math.sqrt(Math.max(0, 1 - eps)) / k
      return t >= 1 ? 0 : 1 - t
    }
    L.push("Fraction of every rib the clamp alters at the user's config: " +
      [1, 2, 4, 8, 16].map((C) => `C=${C}: ${(frac(C) * 100).toFixed(2)}%`).join(', ') + '.')
    L.push('')
  }

  L.push('## Backend parity — max |webgpu - webgl2| per (config, candidate), codes')
  L.push('')
  {
    const cands = [...new Set(sw.rows.filter((r) => r.parityMax != null).map((r) => r.cand))]
    const cfgs = [...new Set(sw.rows.map((r) => r.cfg))]
    L.push('| candidate | ' + cfgs.join(' | ') + ' | worst |')
    L.push('|---' + cfgs.map(() => '|---').join('') + '|---|')
    let worstOverall = 0
    for (const c of cands) {
      const per = cfgs.map((cid) => {
        const rs = sw.rows.filter((r) => r.cfg === cid && r.cand === c && r.parityMax != null)
        return rs.length ? Math.max(...rs.map((r) => r.parityMax!)) : NaN
      })
      const w = Math.max(...per.filter((v) => Number.isFinite(v)))
      if (w > worstOverall) worstOverall = w
      L.push(`| ${c} | ${per.map((v) => (Number.isFinite(v) ? F(v, 1) : '—')).join(' | ')} | ${F(w, 1)} |`)
    }
    L.push('')
    L.push(`Worst cross-backend delta anywhere in the sweep: **${worstOverall.toFixed(1)} codes**. ` +
      'Disqualifying threshold is 1 code.')
    L.push('')
  }

  L.push('## Gates fired on the GT controls? (a gate that fires here is a BENCH BUG)')
  L.push('')
  {
    L.push('| cfg | stim | dpr | GT level | errBand mean | look norm | caustic x | jumpP95 px | fires anything? |')
    L.push('|---|---|---|---|---|---|---|---|---|')
    for (const r of sw.rows.filter((x) => x.cand.startsWith('M6-'))) {
      const fires: string[] = []
      if (r.errBand.mean > ERR_THR) fires.push('errBand')
      if (r.look.norm > lookThr) fires.push('look')
      if (ccThr != null && r.caustic != null && Math.abs(1 - r.caustic) > ccThr) fires.push('caustic')
      const cell = cellOf(r.cfg, r.stimulus, r.dpr)
      if (cell?.jitterThreshPx != null && r.jumpP95 != null && r.jumpP95 > cell.jitterThreshPx) fires.push('jitter')
      if (!fires.length) continue
      L.push(`| ${r.cfg} | ${r.stimulus} | ${r.dpr} | ${r.cand} | ${F(r.errBand.mean)} | ${F(r.look.norm, 5)} | ${F(r.caustic, 4)} | ${F(r.jumpP95)} | **${fires.join(', ')}** |`)
    }
    const anyFired = sw.rows.filter((r) => r.cand.startsWith('M6-')).some((r) => {
      const cell = cellOf(r.cfg, r.stimulus, r.dpr)
      return r.errBand.mean > ERR_THR || r.look.norm > lookThr ||
        (ccThr != null && r.caustic != null && Math.abs(1 - r.caustic) > ccThr) ||
        (cell?.jitterThreshPx != null && r.jumpP95 != null && r.jumpP95 > cell.jitterThreshPx)
    })
    if (!anyFired) L.push('| — | — | — | — | — | — | — | — | none: no gate fires on any GT8/GT16 control anywhere |')
    L.push('')
  }

  L.push('## Per-candidate no-op at the node defaults (V6), in codes')
  L.push('')
  {
    const noop = (results.defaultsNoop ?? []) as Array<{ cand: string; expectedNoop: boolean; max: number; mean: number }>
    const cands = [...new Set(noop.map((n) => n.cand))]
    L.push('| candidate | expected no-op | worst max over (backend x dpr x stimulus) | worst mean | verdict |')
    L.push('|---|---|---|---|---|')
    for (const c of cands) {
      const rs = noop.filter((n) => n.cand === c)
      const mx = Math.max(...rs.map((n) => n.max))
      const mn = Math.max(...rs.map((n) => n.mean))
      const exp = rs[0].expectedNoop
      L.push(`| ${c} | ${exp ? 'yes' : 'no'} | ${mx.toFixed(1)} | ${mn.toFixed(4)} | ` +
        `${exp ? (mx === 0 ? 'no-op CONFIRMED' : '**DEFECT**') : 'not a no-op, by design'} |`)
    }
    L.push('')
  }

  // The tap-budget answer: residual per measured-|L'| bucket.
  {
    const st = results.stratified as {
      buckets: string[]
      byCell: Record<string, { bucketPx: number[]; rows: Array<{ cand: string; buckets: Array<{ range: string; px: number; mean: number | null; max: number | null }> }> }>
    } | undefined
    if (st) {
      L.push("## Residual per MEASURED |L'| bucket (dpr 1.5, reference GT32) — the tap-budget answer")
      L.push('')
      L.push("The band average mixes |L'| = 0.4 pixels with |L'| = 200 pixels into one number. " +
        "These tables render the node's OWN predicate as a per-pixel field and bucket by it.")
      L.push('')
      for (const [cell, v] of Object.entries(st.byCell)) {
        L.push(`### ${cell} — errBand mean (codes) per bucket`)
        L.push('')
        L.push('| candidate | ' + st.buckets.map((b, i) => `${b}<br>(${v.bucketPx[i]} px)`).join(' | ') + ' |')
        L.push('|---' + st.buckets.map(() => '|---').join('') + '|')
        for (const r of v.rows) {
          L.push(`| ${r.cand} | ${r.buckets.map((b) => (b.mean == null ? '—' : b.mean.toFixed(3))).join(' | ')} |`)
        }
        L.push('')
        L.push(`Same cell, worst pixel (max codes) per bucket:`)
        L.push('')
        L.push('| candidate | ' + st.buckets.join(' | ') + ' |')
        L.push('|---' + st.buckets.map(() => '|---').join('') + '|')
        for (const r of v.rows) {
          L.push(`| ${r.cand} | ${r.buckets.map((b) => (b.max == null ? '—' : b.max.toFixed(1))).join(' | ')} |`)
        }
        L.push('')
      }
    }
  }

  // Full row dump as CSV — every row, nothing summarised away.
  const csv: string[] = ['cfg,stimulus,backend,dpr,cand,bandPx,bandTheta,errBandMean,errBandRmse,errBandP999,errBandMax,errAllMean,errAllRmse,errAllMax,lookNorm,lookRmsCodes,lookBias,caustic,jumpP95,jump2nd,peakCodes,grainBand,fetchMean,fetchMin,fetchMax,gpuNsPerDraw,parityMax,parityMean,verdict']
  for (const r of sw.rows) {
    const ctrlErr = rowsOf(r.cfg, r.stimulus, r.dpr, r.backend).find((x) => x.cand === 'M0')?.errBand.mean ?? Infinity
    csv.push([
      r.cfg, r.stimulus, r.backend, r.dpr, r.cand, r.bandPx, r.bandTheta.toFixed(4),
      r.errBand.mean.toFixed(4), r.errBand.rmse.toFixed(4), r.errBand.p999.toFixed(2), r.errBand.max.toFixed(1),
      r.errAll.mean.toFixed(4), r.errAll.rmse.toFixed(4), r.errAll.max.toFixed(1),
      r.look.norm.toFixed(6), r.look.rmsCodes.toFixed(4), r.look.biasCodes.toFixed(4),
      r.caustic == null ? '' : r.caustic.toFixed(5),
      r.jumpP95 == null ? '' : r.jumpP95.toFixed(3),
      r.jump2nd == null ? '' : r.jump2nd.toFixed(4),
      r.peakCodes == null ? '' : r.peakCodes.toFixed(3),
      r.grainBand.toFixed(4),
      r.fetches ? r.fetches.mean.toFixed(4) : '', r.fetches ? r.fetches.min : '', r.fetches ? r.fetches.max : '',
      r.gpuNsPerDraw ?? '',
      r.parityMax == null ? '' : r.parityMax.toFixed(2), r.parityMean == null ? '' : r.parityMean.toFixed(4),
      verdictOf(r, { err: ERR_THR, look: lookThr, caustic: ccThr }, ctrlErr),
    ].join(','))
  }
  fs.writeFileSync(outPath('phase14-minification-sweep', 'csv'), csv.join('\n') + '\n')
  L.push(`Complete row dump (${sw.rows.length} rows, every metric): \`${path.basename(outPath('phase14-minification-sweep', 'csv'))}\`.`)
  L.push('')
}

// ===========================================================================
// Report
// ===========================================================================

function writeReport(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const jp = outPath('phase14-minification', 'json')
  fs.writeFileSync(jp, JSON.stringify(results, null, 2))

  const L: string[] = []
  L.push('# Phase 14 — minification bake-off: BENCH VALIDATION')
  L.push('')
  L.push('Built, not swept. Every metric below is paired with a control it must')
  L.push('fire on and a control it must not.')
  L.push('')
  const gates = (results.gates ?? []) as Gate[]
  L.push('## Gates')
  L.push('')
  L.push('| gate | what | measured | criterion | verdict |')
  L.push('|---|---|---|---|---|')
  for (const g of gates) {
    L.push(`| ${g.id} | ${g.what} | ${g.measured} | ${g.criterion} | ${g.pass ? 'PASS' : '**FAIL**'} |`)
  }
  L.push('')
  const cal = (results.calibration ?? []) as CalRow[]
  L.push('## Metric calibration')
  L.push('')
  L.push('| metric | control | kind | value | fires | expected | verdict |')
  L.push('|---|---|---|---|---|---|---|')
  for (const c of cal) {
    L.push(`| ${c.metric} | ${c.control} | ${c.kind} | ${c.value.toFixed(4)} ${c.unit} | ${c.fires} | ${c.expected} | ${c.ok ? 'PASS' : '**FAIL**'} |`)
  }
  L.push('')
  L.push('## Metrics that were DROPPED, and why')
  L.push('')
  L.push('| metric | verdict | reason |')
  L.push('|---|---|---|')
  const st = results.seamTrack as { discriminates?: boolean; rows?: Record<string, { jumpP95: number }>; threshold?: number; searchedWindow?: { gtJump: number } } | undefined
  if (st) {
    L.push(`| seamJumpP95 (contour jitter) | ${st.discriminates ? 'KEPT' : '**DROPPED**'} | ` +
      `GT64 ${st.searchedWindow?.gtJump.toFixed(3)} px, M0 ${st.rows?.['KB M0'].jumpP95.toFixed(3)} px, threshold ${st.threshold?.toFixed(3)} px |`)
  }
  const cc = results.causticContrast as { usable?: boolean; kgWorstDeviation?: number; kbBestDeviation?: number } | undefined
  if (cc) {
    L.push(`| causticContrast | ${cc.usable ? 'KEPT' : '**DROPPED**'} | ` +
      `worst known-good deviation ${cc.kgWorstDeviation?.toFixed(4)}, best known-bad ${cc.kbBestDeviation?.toFixed(4)} |`)
  }
  const es = results.edgeMetricsStaircase as { validAtLowCurvature?: boolean; validAtUserCurvature?: boolean } | undefined
  if (es) {
    L.push(`| lib/edge-metrics.staircase | ${es.validAtUserCurvature ? 'KEPT' : '**DROPPED at curvature 2.15**'} | ` +
      `valid at curvature 0.80 = ${es.validAtLowCurvature} (the regime phase 10/12 published in), at 2.15 = ${es.validAtUserCurvature} |`)
  }
  L.push('')
  L.push('## What is EMULATED rather than emitted by the node')
  L.push('')
  const meta = results.meta as { emulationNotes?: Record<string, string> } | undefined
  for (const [k, v] of Object.entries(meta?.emulationNotes ?? {})) L.push(`- **${k}** — ${v}`)
  L.push('')
  L.push('## Candidates')
  L.push('')
  L.push('| id | family | nominal fetches | no-op at defaults | label |')
  L.push('|---|---|---|---|---|')
  for (const c of CANDIDATES) {
    const noop = c.probe ? 'n/a (probe)' : c.unconditional ? '**no — unconditional**' : c.family === 'M6' ? 'n/a (reference)' : 'yes (gated)'
    L.push(`| ${c.id} | ${c.family} | ${c.nominalFetches} | ${noop} | ${c.label} |`)
  }
  L.push('')
  writeSweepReport(L)
  L.push('## Running the sweep')
  L.push('')
  L.push('`npx tsx scripts/blur-bakeoff/phase14-minification.ts --sweep` runs the validation')
  L.push('above and then the full matrix (11 configs x 3 stimuli x 2 backends x dpr {1.5, 2}).')
  L.push('The sweep\'s reference is GT32 on the primary backend — |GT32-GT64| measured 0.037')
  L.push('codes rmse on the flat stimulus and |GT32(webgpu)-GT32(webgl2)| 0.001, both far below')
  L.push('the separations being ranked.')
  L.push('')
  L.push(`Full numbers: \`${path.basename(outPath('phase14-minification', 'json'))}\`.`)
  fs.writeFileSync(outPath('phase14-minification', 'md'), L.join('\n') + '\n')
  console.log(`\n  wrote ${jp}`)
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2)
  const doSweep = args.includes('--sweep')
  const emitOnly = args.includes('--emit')
  const diagOnly = args.includes('--diag')
  const cfgFilter = args.find((a) => a.startsWith('--configs='))?.split('=')[1]?.split(',') ?? null
  // Smoke-test escape hatch. Re-uses the calibration from an EXISTING json (whose
  // gates must all have passed) instead of re-measuring it. Never used for the
  // reported run: the reported run measures gates and sweep in one process.
  const reuseVal = args.includes('--reuse-validation')
  /** Regenerate only the plates (they are pure re-renders of cells the sweep
   *  already measured, so this cannot change a number). */
  const platesOnly = args.includes('--plates')
  /** Error stratified by the measured per-pixel |L'| (the tap-budget question). */
  const stratOnly = args.includes('--strat')
  // Rewrite the markdown from an existing JSON, so a change to the report layout
  // does not require a six-minute re-measure.
  OUT_SUFFIX = args.find((a) => a.startsWith('--out='))?.split('=')[1] ?? ''
  if (args.includes('--report')) {
    const jp = outPath('phase14-minification', 'json')
    if (!fs.existsSync(jp)) throw new Error(`--report: ${jp} does not exist yet`)
    Object.assign(results, JSON.parse(fs.readFileSync(jp, 'utf8')) as Record<string, unknown>)
    writeReport()
    return
  }
  const onlyBackend = args.find((a) => a.startsWith('--backend='))?.split('=')[1] as Backend | undefined

  // Always emit-check first: it is free and it fails loudly.
  const emit = runEmit(true)
  results.emit = { built: emit.rows.length, failures: emit.failures }
  if (emit.failures.length) throw new Error(`emit check failed:\n${emit.failures.join('\n')}`)
  if (emitOnly) { writeReport(); return }

  const rig = await createAaRig()
  console.log(`adapter: ${rig.adapterInfo}`)
  console.log(`backends: webgpu=${rig.available.webgpu} webgl2=${rig.available.webgl2} timestamp=${rig.hasTimestamp}`)
  const backends: Backend[] = onlyBackend
    ? [onlyBackend]
    : ([...(rig.available.webgpu ? ['webgpu'] : []), ...(rig.available.webgl2 ? ['webgl2'] : [])] as Backend[])
  if (backends.length === 0) throw new Error('no backend available')
  results.meta = {
    adapter: rig.adapterInfo, backends, frame: { W, H, margin: MARGIN }, dprs: DPRS,
    lookSigmaCandidatesPx: [2, 4, 8, 12], lookSigmaDefaultPx: LOOK_SIGMA, grainSigmaPx: GRAIN_SIGMA,
    lookSigmaNote: 'the look metric\'s sigma is CHOSEN BY THE CALIBRATION sweep, not a priori; the chosen value is in results.look.chosenSigmaPx',
    emulationNotes: {
      E1: "taps re-evaluate the wave field; emitLensTail first-order-extrapolates the rib phase. Measured as V3c. Makes the bench's per-tap cost higher and its tap position very slightly more accurate than a real node change.",
      E2: 'taps are averaged with straight alpha, not premultiplied. Gate V5 asserts full opacity, which makes the two identical here. A real node change must premultiply.',
      E3: 'M2/M6 wrap the WHOLE node body per tap (as the prior study\'s A3 and the GT do), so each tap re-runs the rib field. M1/M4/M7 do too.',
      E4: 'M3 and M5 are genuine one-token source patches of the node\'s own reedLens, asserted to apply exactly once per backend.',
    },
  }

  try {
    if (diagOnly) { await runDiag(rig, backends[0]); return }
    // Validation ALWAYS runs first, even under --sweep: the sweep reads the look
    // metric's calibrated sigma out of it, and a sweep on uncalibrated metrics is
    // exactly the failure mode this phase exists to avoid.
    if (reuseVal) {
      const jp = outPath('phase14-minification', 'json')
      if (!fs.existsSync(jp)) throw new Error('--reuse-validation: no existing json to read the calibration from')
      const prev = JSON.parse(fs.readFileSync(jp, 'utf8')) as Record<string, unknown>
      const pg = (prev.gates ?? []) as Gate[]
      const pc = (prev.calibration ?? []) as CalRow[]
      if (!pg.length || pg.some((g) => !g.pass) || pc.some((c) => !c.ok)) {
        throw new Error('--reuse-validation: the existing json has failing gates; re-run the validation')
      }
      // Copy EVERY key, not a hand-listed subset: a follow-up stage run
      // (--strat / --plates) must not drop the sweep rows out of the json, and a
      // hand-maintained list is exactly how that happens. `meta` is the one key
      // the current process owns, so it is restored after the copy.
      const freshMeta = results.meta
      Object.assign(results, prev)
      results.meta = freshMeta
      results.validationReused = true
      console.log(`  reusing calibration from ${jp}: ${pg.length} gates, ${pc.length} calibration rows, all passing`)
    } else {
      await runValidate(rig, backends)
    }
    if (doSweep) await runSweep(rig, backends, cfgFilter)
    if (doSweep || stratOnly) await runStratified(rig, backends)
    if (doSweep || platesOnly) await runPlates(rig, backends)
  } finally {
    writeReport()
    await rig.close()
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
