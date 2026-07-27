// Candidate shader generators. One generator emits both backends from the same
// structure, so a GLSL/WGSL divergence is a code bug rather than a transcription
// slip. Kernel weights come from the same gaussianKernel1D() the CPU reference
// uses, which is what makes a GPU-vs-reference comparison meaningful.
//
// Taps are fully UNROLLED with literal weights and offsets. That is portable
// (no dynamic indexing of a const array, no non-constant loop bounds on GL ES
// 3.0) and it mirrors how a baked, recompile-mode tap count really ships.

import { gaussianKernel1D } from './reference'
import type { Backend, PassSpec } from './gpu-rig'

interface Syntax {
  decl(type: string, name: string, init: string): string
  sel(cond: string, t: string, f: string): string
}

function syntax(backend: Backend): Syntax {
  // WGSL gets `alias vec2/vec3/vec4/float` from the rig preamble, so GLSL-style
  // type names work on both and only these two forms actually differ.
  return backend === 'webgpu'
    ? {
        decl: (t, n, init) => `var ${n}: ${t} = ${init};`,
        sel: (c, t, f) => `select(${f}, ${t}, ${c})`,
      }
    : {
        decl: (t, n, init) => `${t} ${n} = ${init};`,
        sel: (c, t, f) => `((${c}) ? (${t}) : (${f}))`,
      }
}

/** Exact piecewise sRGB transfer functions, matching lib/color.ts. */
export function srgbPrelude(backend: Backend): string {
  const fn =
    backend === 'webgpu'
      ? `
fn toLin(c: vec3) -> vec3 {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
fn toSrgb(c: vec3) -> vec3 {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`
      : `
vec3 toLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`
  return fn
}

export interface SeparableOpts {
  backend: Backend
  sigma: number
  axis: 'h' | 'v'
  /**
   * Shorthand: the source is sRGB-encoded and the target must be too, so decode
   * taps to linear light and re-encode the result. Override per-side with
   * inputEncoded/outputEncoded when an intermediate can hold linear values
   * (a float16 target should, since re-encoding to sRGB throws away the
   * precision that made it worth allocating).
   */
  linearize: boolean
  /** Source holds sRGB-encoded values (default: `linearize`). */
  inputEncoded?: boolean
  /** Target must hold sRGB-encoded values (default: `linearize`). */
  outputEncoded?: boolean
  /** Weight rgb by alpha before averaging, then divide out (no edge fringing). */
  premultiply: boolean
  /** Override tap count (defaults to the reference kernel's full width). */
  maxTaps?: number
  /** Add sub-LSB noise before the 8-bit write, to break up banding. */
  dither?: boolean
  /** Multiply linear taps by this before accumulating (simulates HDR headroom). */
  preScale?: number
  /** Divide the result by this before encoding (inverse of preScale). */
  postScale?: number
}

/** White-noise dither of one 8-bit LSB. Blue noise would look better; this is
 *  enough to measure whether dithering rescues an 8-bit intermediate at all. */
export function ditherPrelude(backend: Backend): string {
  return backend === 'webgpu'
    ? `
fn ditherNoise(p: vec2) -> float {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`
    : `
float ditherNoise(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`
}

/**
 * One axis of a separable Gaussian. Run twice (h then v) for a full blur.
 * Returns a PassSpec ready for the rig.
 */
export function separableGaussianPass(opts: SeparableOpts): PassSpec {
  const { backend, sigma, axis, premultiply } = opts
  const decodeIn = opts.inputEncoded ?? opts.linearize
  const encodeOut = opts.outputEncoded ?? opts.linearize
  const s = syntax(backend)
  const kernel = gaussianKernel1D(sigma)
  let weights = Array.from(kernel)
  let radius = (weights.length - 1) / 2

  // Optionally narrow the kernel (used to study undersampling), renormalizing.
  if (opts.maxTaps && opts.maxTaps < weights.length) {
    const r = Math.floor(opts.maxTaps / 2)
    const start = radius - r
    weights = weights.slice(start, start + r * 2 + 1)
    const sum = weights.reduce((a, b) => a + b, 0)
    weights = weights.map((w) => w / sum)
    radius = r
  }

  const dir = axis === 'h' ? ['1.0', '0.0'] : ['0.0', '1.0']
  const lines: string[] = []
  lines.push(s.decl('vec3', 'acc', 'vec3(0.0)'))
  lines.push(s.decl('float', 'aacc', '0.0'))
  lines.push(s.decl('vec4', 'c', 'vec4(0.0)'))

  for (let i = 0; i < weights.length; i++) {
    const off = i - radius
    const w = weights[i].toPrecision(9)
    const uvExpr = `uv + vec2(${dir[0]}, ${dir[1]}) * (${off.toFixed(1)} * U.u_texel)`
    lines.push(`  c = sampleSrc(${uvExpr});`)
    const decoded = decodeIn ? 'toLin(c.rgb)' : 'c.rgb'
    const rgb = opts.preScale ? `(${decoded} * ${opts.preScale.toFixed(1)})` : decoded
    if (premultiply) {
      lines.push(`  acc = acc + ${rgb} * (c.a * ${w});`)
      lines.push(`  aacc = aacc + c.a * ${w};`)
    } else {
      lines.push(`  acc = acc + ${rgb} * ${w};`)
      lines.push(`  aacc = aacc + c.a * ${w};`)
    }
  }

  if (premultiply) {
    // Divide the premultiplied sum by accumulated alpha to return straight alpha.
    lines.push(s.decl('vec3', 'outRgb', s.sel('aacc > 0.0', 'acc / aacc', 'vec3(0.0)')))
    lines.push(s.decl('vec3', 'lin', opts.postScale ? `outRgb / ${opts.postScale.toFixed(1)}` : 'outRgb'))
    lines.push(s.decl('vec3', 'enc', encodeOut ? 'toSrgb(lin)' : 'lin'))
  } else {
    lines.push(s.decl('vec3', 'lin', opts.postScale ? `acc / ${opts.postScale.toFixed(1)}` : 'acc'))
    lines.push(s.decl('vec3', 'enc', encodeOut ? 'toSrgb(lin)' : 'lin'))
  }
  if (opts.dither) {
    lines.push(`  enc = enc + vec3((ditherNoise(uv * U.u_resolution) - 0.5) / 255.0);`)
  }
  lines.push(`  return vec4(enc, aacc);`)

  const preludes = [decodeIn || encodeOut ? srgbPrelude(backend) : '', opts.dither ? ditherPrelude(backend) : '']
    .filter(Boolean)
    .join('\n')
  return {
    body: lines.join('\n'),
    prelude: preludes || undefined,
  }
}

/**
 * Convenience: the two passes of a full separable Gaussian blur.
 *
 * With `linearIntermediate`, the horizontal pass leaves its result in linear
 * light and the vertical pass consumes it directly — the correct pairing for a
 * float16 target, and it also drops one pow() per tap in the second pass.
 * Without it, each pass re-encodes to sRGB (what an 8-bit target requires).
 */
export function separableGaussianPasses(
  opts: Omit<SeparableOpts, 'axis'> & { float16?: boolean; scale?: number; linearIntermediate?: boolean },
): PassSpec[] {
  const lin = !!opts.linearIntermediate && opts.linearize
  const h = separableGaussianPass({ ...opts, axis: 'h', outputEncoded: lin ? false : undefined })
  const v = separableGaussianPass({ ...opts, axis: 'v', inputEncoded: lin ? false : undefined })
  return [
    { ...h, filter: 'nearest', float16: opts.float16, scale: opts.scale },
    { ...v, filter: 'nearest' },
  ]
}

/** A single box-blur pass (unrolled), for the box-x3 CLT candidate. */
export function boxPass(opts: {
  backend: Backend
  radiusPx: number
  axis: 'h' | 'v'
  linearize: boolean
}): PassSpec {
  const { backend, radiusPx, axis, linearize } = opts
  const s = syntax(backend)
  const r = Math.max(1, Math.round(radiusPx))
  const n = r * 2 + 1
  const w = (1 / n).toPrecision(9)
  const dir = axis === 'h' ? ['1.0', '0.0'] : ['0.0', '1.0']
  const lines: string[] = []
  lines.push(s.decl('vec3', 'acc', 'vec3(0.0)'))
  lines.push(s.decl('float', 'aacc', '0.0'))
  lines.push(s.decl('vec4', 'c', 'vec4(0.0)'))
  for (let i = -r; i <= r; i++) {
    lines.push(`  c = sampleSrc(uv + vec2(${dir[0]}, ${dir[1]}) * (${i.toFixed(1)} * U.u_texel));`)
    lines.push(`  acc = acc + ${linearize ? 'toLin(c.rgb)' : 'c.rgb'} * ${w};`)
    lines.push(`  aacc = aacc + c.a * ${w};`)
  }
  lines.push(`  return vec4(${linearize ? 'toSrgb(acc)' : 'acc'}, aacc);`)
  return { body: lines.join('\n'), prelude: linearize ? srgbPrelude(backend) : undefined, filter: 'nearest' }
}

/** Plain passthrough (used for resampling / pyramid up-down steps). */
export function passthroughPass(filter: 'linear' | 'nearest' = 'linear'): PassSpec {
  return { body: 'return sampleSrc(uv);', filter }
}

// ===========================================================================
// Bake-off candidates.
//
// Phase 2 settled two things, so they are no longer per-candidate options:
// averaging happens in linear light (E1) and alpha is premultiplied (E2). Rather
// than convert inside every pass, each candidate is bracketed by one ingest and
// one egress pass:
//
//   ingest:  sRGB straight  ->  linear premultiplied
//   kernels: plain weighted averages of premultiplied linear RGBA
//   egress:  linear premultiplied -> sRGB straight (+ optional dither)
//
// Averaging premultiplied linear RGBA is exactly the correct operation, so the
// kernels need no colour knowledge at all. That makes them directly comparable,
// and it is also how a real implementation should be built: two conversions
// total instead of two per pass.
// ===========================================================================

/** sRGB straight -> linear premultiplied. */
export function ingestPass(backend: Backend): PassSpec {
  return {
    prelude: srgbPrelude(backend),
    body: `
  ${syntax(backend).decl('vec4', 'c', 'sampleSrc(uv)')}
  return vec4(toLin(c.rgb) * c.a, c.a);`,
    filter: 'nearest',
  }
}

/** linear premultiplied -> sRGB straight. Optional one-LSB dither (Phase 2 E3). */
export function egressPass(backend: Backend, opts?: { dither?: boolean }): PassSpec {
  const s = syntax(backend)
  const lines = [
    s.decl('vec4', 'c', 'sampleSrc(uv)'),
    s.decl('vec3', 'lin', s.sel('c.a > 0.0', 'c.rgb / c.a', 'vec3(0.0)')),
    s.decl('vec3', 'enc', 'toSrgb(lin)'),
  ]
  if (opts?.dither) lines.push(`  enc = enc + vec3((ditherNoise(uv * U.u_resolution) - 0.5) / 255.0);`)
  lines.push(`  return vec4(enc, c.a);`)
  return {
    prelude: srgbPrelude(backend) + (opts?.dither ? ditherPrelude(backend) : ''),
    body: lines.join('\n'),
    filter: 'linear',
  }
}

/** Pure separable Gaussian kernel (no colour conversion), one axis. */
export function gaussKernelPass(backend: Backend, sigma: number, axis: 'h' | 'v'): PassSpec {
  return separableGaussianPass({ backend, sigma, axis, linearize: false, premultiply: false })
}

/**
 * Linear-sampled separable Gaussian (RasterGrid): fold adjacent tap pairs into a
 * single bilinear fetch at a weighted offset, roughly halving texture reads.
 * Requires linear filtering — with nearest it degenerates and drops taps.
 */
export function linearSampledGaussPass(backend: Backend, sigma: number, axis: 'h' | 'v'): PassSpec {
  const s = syntax(backend)
  const k = gaussianKernel1D(sigma)
  const r = (k.length - 1) / 2
  const dir = axis === 'h' ? ['1.0', '0.0'] : ['0.0', '1.0']

  // centre tap alone, then fold pairs (1,2), (3,4), ... outward on both sides
  const taps: Array<{ off: number; w: number }> = [{ off: 0, w: k[r] }]
  for (let i = 1; i <= r; i += 2) {
    const w1 = k[r + i]
    const w2 = i + 1 <= r ? k[r + i + 1] : 0
    const w = w1 + w2
    if (w <= 0) continue
    const off = (i * w1 + (i + 1) * w2) / w
    taps.push({ off, w })
    taps.push({ off: -off, w })
  }

  const lines = [s.decl('vec4', 'acc', 'vec4(0.0)')]
  for (const t of taps) {
    lines.push(
      `  acc = acc + sampleSrc(uv + vec2(${dir[0]}, ${dir[1]}) * (${t.off.toPrecision(9)} * U.u_texel)) * ${t.w.toPrecision(9)};`,
    )
  }
  lines.push('  return acc;')
  return { body: lines.join('\n'), filter: 'linear' }
}

/** Pure box kernel, one axis. Three H+V rounds approach a Gaussian (CLT). */
export function boxKernelPass(backend: Backend, radiusPx: number, axis: 'h' | 'v'): PassSpec {
  const s = syntax(backend)
  const r = Math.max(1, Math.round(radiusPx))
  const w = (1 / (r * 2 + 1)).toPrecision(9)
  const dir = axis === 'h' ? ['1.0', '0.0'] : ['0.0', '1.0']
  const lines = [s.decl('vec4', 'acc', 'vec4(0.0)')]
  for (let i = -r; i <= r; i++) {
    lines.push(`  acc = acc + sampleSrc(uv + vec2(${dir[0]}, ${dir[1]}) * (${i.toFixed(1)} * U.u_texel)) * ${w};`)
  }
  lines.push('  return acc;')
  return { body: lines.join('\n'), filter: 'nearest' }
}

/**
 * Kawase pass: four bilinear fetches at the diagonals of a square of half-width
 * `offset`, exploiting hardware filtering so each fetch averages four texels.
 * Successive passes with growing offsets accumulate toward a Gaussian-ish shape.
 */
export function kawasePass(backend: Backend, offset: number): PassSpec {
  const s = syntax(backend)
  const d = (offset + 0.5).toPrecision(9)
  const lines = [
    s.decl('vec4', 'acc', 'vec4(0.0)'),
    `  acc = acc + sampleSrc(uv + vec2( ${d}, ${d}) * U.u_texel);`,
    `  acc = acc + sampleSrc(uv + vec2(-${d}, ${d}) * U.u_texel);`,
    `  acc = acc + sampleSrc(uv + vec2( ${d}, -${d}) * U.u_texel);`,
    `  acc = acc + sampleSrc(uv + vec2(-${d}, -${d}) * U.u_texel);`,
    '  return acc * 0.25;',
  ]
  return { body: lines.join('\n'), filter: 'linear' }
}

/** Bjorge dual-filter downsample: centre weighted 4, plus four diagonals, /8. */
export function dualFilterDownPass(backend: Backend): PassSpec {
  const s = syntax(backend)
  const lines = [
    s.decl('vec4', 'sum', 'sampleSrc(uv) * 4.0'),
    `  sum = sum + sampleSrc(uv + vec2(-1.0, -1.0) * U.u_texel);`,
    `  sum = sum + sampleSrc(uv + vec2( 1.0, 1.0) * U.u_texel);`,
    `  sum = sum + sampleSrc(uv + vec2( 1.0, -1.0) * U.u_texel);`,
    `  sum = sum + sampleSrc(uv + vec2(-1.0, 1.0) * U.u_texel);`,
    '  return sum / 8.0;',
  ]
  return { body: lines.join('\n'), filter: 'linear' }
}

/** Bjorge dual-filter upsample: 8 taps, edge midpoints weighted 2, corners 1, /12. */
export function dualFilterUpPass(backend: Backend): PassSpec {
  const s = syntax(backend)
  const lines = [
    s.decl('vec4', 'sum', 'vec4(0.0)'),
    `  sum = sum + sampleSrc(uv + vec2(-1.0,  0.0) * U.u_texel) * 2.0;`,
    `  sum = sum + sampleSrc(uv + vec2( 1.0,  0.0) * U.u_texel) * 2.0;`,
    `  sum = sum + sampleSrc(uv + vec2( 0.0, -1.0) * U.u_texel) * 2.0;`,
    `  sum = sum + sampleSrc(uv + vec2( 0.0,  1.0) * U.u_texel) * 2.0;`,
    `  sum = sum + sampleSrc(uv + vec2(-1.0, -1.0) * U.u_texel);`,
    `  sum = sum + sampleSrc(uv + vec2( 1.0, -1.0) * U.u_texel);`,
    `  sum = sum + sampleSrc(uv + vec2(-1.0,  1.0) * U.u_texel);`,
    `  sum = sum + sampleSrc(uv + vec2( 1.0,  1.0) * U.u_texel);`,
    '  return sum / 12.0;',
  ]
  return { body: lines.join('\n'), filter: 'linear' }
}
