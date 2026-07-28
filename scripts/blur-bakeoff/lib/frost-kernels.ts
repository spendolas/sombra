// Frost scatter kernels — CPU, linear-light, premultiplied-correct.
//
// Everything here operates on FloatImage (linear light, straight alpha) and,
// with { premultiplied: true }, does premultiply -> average -> unpremultiply so
// transparent colour never bleeds. Same contract as lib/reference.ts.
//
// Three CONVERGED kernels (the "target look" candidates):
//   discBlurFast  — uniform average over a disc of radius R. The physically
//                   honest model of an isotropic scatter with a hard cutoff.
//                   O(W*H*R) via per-row prefix sums; bit-identical to the
//                   O(W*H*R^2) reference2.discBlur (asserted in phase9-target).
//   boxBlurUniform— uniform average over a SQUARE of half-extent R. This is the
//                   footprint the shipped shader actually integrates over,
//                   because reedHash returns vec2 in [-1,1]^2.
//   gaussian      — via reference.gaussianBlur, sigma chosen to match a target
//                   second moment (see sigmaForDisc / sigmaForBox).
//
// Two DEGRADATIONS (the "known bad" candidates):
//   blockQuantize   — average the RESULT onto a block x block grid. The literal
//                     "looks like pixelation" hypothesis.
//   sparseTapScatter— a faithful CPU re-implementation of the shipped shader's
//                     frost loop, including the exact reedHash bit mixing, the
//                     block-quantised seed lattice, mirror-fold edge handling
//                     and premultiplied accumulation. This is what the GPU
//                     actually draws, and it is NOT the same thing as
//                     blockQuantize — the tap CENTRE still moves per pixel.

import { createFloat, premultiply, unpremultiply, type FloatImage } from './image'
import { gaussianBlur } from './reference'

interface Opts {
  premultiplied?: boolean
}

function clampInt(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v
}

// ---------------------------------------------------------------------------
// Second-moment matching.
// A kernel's per-axis variance is what fixes its apparent "amount of blur".
// Uniform disc radius R:   Var = R^2 / 4       -> sigma = R / 2
// Uniform square half R:   Var = R^2 / 3       -> sigma = R / sqrt(3)
// Matching second moments is the only fair way to compare kernel SHAPE without
// also comparing kernel SIZE.
// ---------------------------------------------------------------------------
export function sigmaForDisc(radius: number): number {
  return radius / 2
}
export function sigmaForBox(halfExtent: number): number {
  return halfExtent / Math.sqrt(3)
}

export function gaussianMatched(img: FloatImage, sigma: number, opts?: Opts): FloatImage {
  return gaussianBlur(img, sigma, opts)
}

// ---------------------------------------------------------------------------
// Uniform disc, O(W*H*R) via per-row prefix sums, clamp-to-edge.
// Membership test is dx*dx + dy*dy <= R*R over integer offsets, identical to
// reference2.discBlur — this is an exact acceleration, not an approximation.
// ---------------------------------------------------------------------------
export function discBlurFast(img: FloatImage, radius: number, opts?: Opts): FloatImage {
  const src = opts?.premultiplied ? premultiply(img) : img
  const { width: W, height: H } = src
  const R = Math.max(0.5, radius)
  const ri = Math.ceil(R)
  const R2 = R * R

  // half-width of the disc on each row offset; -1 = row outside the disc
  const halfW = new Int32Array(ri * 2 + 1)
  let count = 0
  for (let dy = -ri; dy <= ri; dy++) {
    const rem = R2 - dy * dy
    if (rem < 0) {
      halfW[dy + ri] = -1
      continue
    }
    let h = Math.floor(Math.sqrt(rem))
    while ((h + 1) * (h + 1) <= rem) h++
    while (h > 0 && h * h > rem) h--
    if (h * h > rem) {
      halfW[dy + ri] = -1
      continue
    }
    halfW[dy + ri] = h
    count += 2 * h + 1
  }
  if (count === 0) return src

  // prefix[(y*(W+1) + x)*4 + c] = sum of src rows[y] channel c over columns < x
  const prefix = new Float64Array((W + 1) * H * 4)
  for (let y = 0; y < H; y++) {
    const rowBase = y * (W + 1) * 4
    for (let c = 0; c < 4; c++) prefix[rowBase + c] = 0
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4
      for (let c = 0; c < 4; c++) {
        prefix[rowBase + (x + 1) * 4 + c] = prefix[rowBase + x * 4 + c] + src.data[si + c]
      }
    }
  }

  const out = createFloat(W, H)
  const inv = 1 / count
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0
      for (let dy = -ri; dy <= ri; dy++) {
        const h = halfW[dy + ri]
        if (h < 0) continue
        const sy = clampInt(y + dy, H - 1)
        const rowBase = sy * (W + 1) * 4
        const edgeL = (sy * W + 0) * 4
        const edgeR = (sy * W + (W - 1)) * 4
        const xa = x - h
        const xb = x + h
        const lo = xa < 0 ? 0 : xa
        const hi = xb > W - 1 ? W - 1 : xb
        const nL = xa < 0 ? -xa : 0
        const nR = xb > W - 1 ? xb - (W - 1) : 0
        if (lo <= hi) {
          const pHi = rowBase + (hi + 1) * 4
          const pLo = rowBase + lo * 4
          a0 += prefix[pHi] - prefix[pLo]
          a1 += prefix[pHi + 1] - prefix[pLo + 1]
          a2 += prefix[pHi + 2] - prefix[pLo + 2]
          a3 += prefix[pHi + 3] - prefix[pLo + 3]
        }
        if (nL > 0) {
          a0 += src.data[edgeL] * nL
          a1 += src.data[edgeL + 1] * nL
          a2 += src.data[edgeL + 2] * nL
          a3 += src.data[edgeL + 3] * nL
        }
        if (nR > 0) {
          a0 += src.data[edgeR] * nR
          a1 += src.data[edgeR + 1] * nR
          a2 += src.data[edgeR + 2] * nR
          a3 += src.data[edgeR + 3] * nR
        }
      }
      const di = (y * W + x) * 4
      out.data[di] = a0 * inv
      out.data[di + 1] = a1 * inv
      out.data[di + 2] = a2 * inv
      out.data[di + 3] = a3 * inv
    }
  }
  return opts?.premultiplied ? unpremultiply(out) : out
}

// ---------------------------------------------------------------------------
// Uniform square (box) of half-extent h, separable, clamp-to-edge.
// ---------------------------------------------------------------------------
export function boxBlurUniform(img: FloatImage, halfExtent: number, opts?: Opts): FloatImage {
  const src = opts?.premultiplied ? premultiply(img) : img
  const h = Math.max(0, Math.round(halfExtent))
  if (h === 0) return opts?.premultiplied ? unpremultiply(src) : src
  const tmp = box1D(src, h, 'h')
  const out = box1D(tmp, h, 'v')
  return opts?.premultiplied ? unpremultiply(out) : out
}

function box1D(img: FloatImage, h: number, axis: 'h' | 'v'): FloatImage {
  const { width: W, height: H, data } = img
  const out = createFloat(W, H)
  const n = 2 * h + 1
  const inv = 1 / n
  if (axis === 'h') {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0
        for (let t = -h; t <= h; t++) {
          const si = (y * W + clampInt(x + t, W - 1)) * 4
          a0 += data[si]; a1 += data[si + 1]; a2 += data[si + 2]; a3 += data[si + 3]
        }
        const di = (y * W + x) * 4
        out.data[di] = a0 * inv; out.data[di + 1] = a1 * inv
        out.data[di + 2] = a2 * inv; out.data[di + 3] = a3 * inv
      }
    }
  } else {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0
        for (let t = -h; t <= h; t++) {
          const si = (clampInt(y + t, H - 1) * W + x) * 4
          a0 += data[si]; a1 += data[si + 1]; a2 += data[si + 2]; a3 += data[si + 3]
        }
        const di = (y * W + x) * 4
        out.data[di] = a0 * inv; out.data[di + 1] = a1 * inv
        out.data[di + 2] = a2 * inv; out.data[di + 3] = a3 * inv
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Degradation 1: average the RESULT onto a block x block grid.
// This is the strong form of the "looks like pixelation" hypothesis — every
// pixel in a block gets an identical value.
// ---------------------------------------------------------------------------
export function blockQuantize(img: FloatImage, block: number, opts?: Opts): FloatImage {
  const src = opts?.premultiplied ? premultiply(img) : img
  const { width: W, height: H, data } = src
  const out = createFloat(W, H)
  const b = Math.max(1, Math.round(block))
  for (let by = 0; by < H; by += b) {
    for (let bx = 0; bx < W; bx += b) {
      const x1 = Math.min(bx + b, W)
      const y1 = Math.min(by + b, H)
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, n = 0
      for (let y = by; y < y1; y++)
        for (let x = bx; x < x1; x++) {
          const si = (y * W + x) * 4
          a0 += data[si]; a1 += data[si + 1]; a2 += data[si + 2]; a3 += data[si + 3]; n++
        }
      const inv = 1 / n
      for (let y = by; y < y1; y++)
        for (let x = bx; x < x1; x++) {
          const di = (y * W + x) * 4
          out.data[di] = a0 * inv; out.data[di + 1] = a1 * inv
          out.data[di + 2] = a2 * inv; out.data[di + 3] = a3 * inv
        }
    }
  }
  return opts?.premultiplied ? unpremultiply(out) : out
}

// ---------------------------------------------------------------------------
// reedHash — exact CPU mirror of the GLSL/WGSL function in
// src/nodes/transform/reeded-glass.ts. fp32 bit-for-bit: floatBitsToUint on the
// fp32 representation, uint32 wrap-around arithmetic, xor-shift, /2^32.
// ---------------------------------------------------------------------------
const F32 = new Float32Array(1)
const U32 = new Uint32Array(F32.buffer)

function floatBitsToUint(x: number): number {
  F32[0] = x
  return U32[0] >>> 0
}

/** Returns two components in roughly [-1, 1). */
export function reedHash(px: number, py: number): [number, number] {
  let qx = floatBitsToUint(px)
  let qy = floatBitsToUint(py)
  qx = (Math.imul(qx, 1103515245) + 12345) >>> 0
  qy = (Math.imul(qy, 1103515245) + 12345) >>> 0
  qx = (qx + Math.imul(qy, 1664525)) >>> 0
  qy = (qy + Math.imul(qx, 1013904223)) >>> 0
  qx = (qx ^ (qx >>> 16)) >>> 0
  qy = (qy ^ (qy >>> 16)) >>> 0
  // GLSL: float(0xFFFFFFFFu) rounds to 4294967296.0 in fp32.
  const D = 4294967296
  return [
    Math.fround(Math.fround(Math.fround(qx) / D) * 2 - 1),
    Math.fround(Math.fround(Math.fround(qy) / D) * 2 - 1),
  ]
}

// ---------------------------------------------------------------------------
// Degradation 2: the shipped shader's actual frost loop, on CPU.
//
//   seedBlockPx = 0  -> per-pixel seed (the lattice removed)
//   seedBlockPx > 0  -> the shipped behaviour; seed = floor(devicePx / block),
//                       which is what floor(rg_coords * u_ref_size*0.25)
//                       evaluates to (rg_coords unit = u_dpr * 512 device px,
//                       so one lattice cell = u_dpr * 4 device px).
//
// footprint 'square' reproduces reedHash's [-1,1]^2 range; 'disc' rejects
// samples outside the unit circle and re-rolls, for the shape ablation.
// Accumulation is premultiplied exactly as the shader does it, including
// alpha = sum(a) / taps, so "don't invent alpha" holds.
// ---------------------------------------------------------------------------
export interface SparseTapOpts {
  halfExtentPx: number
  taps: number
  seedBlockPx: number
  footprint?: 'square' | 'disc'
  /** Extra offset added to the lattice index, to simulate a DPR/scale re-roll. */
  seedPhase?: number
}

export function sparseTapScatter(img: FloatImage, o: SparseTapOpts): FloatImage {
  const { width: W, height: H } = img
  const src = premultiply(img)
  const out = createFloat(W, H)
  const taps = o.taps
  const rad = o.halfExtentPx
  const block = o.seedBlockPx
  const disc = o.footprint === 'disc'
  const phase = o.seedPhase ?? 0
  const tap: number[] = [0, 0, 0, 0]

  // fp32 per-index hash salts, exactly as generated: float(i)*7.31, float(i)*-11.13
  const saltX = new Float64Array(taps * 4)
  const saltY = new Float64Array(taps * 4)
  for (let i = 0; i < taps * 4; i++) {
    saltX[i] = Math.fround(Math.fround(i) * Math.fround(7.31))
    saltY[i] = Math.fround(Math.fround(i) * Math.fround(-11.13))
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // phase must apply to the per-pixel seed too, otherwise the re-roll
      // experiment silently compares an image with itself.
      const gx = (block > 0 ? Math.floor(x / block) : x) + phase
      const gy = (block > 0 ? Math.floor(y / block) : y) + phase
      let r = 0, g = 0, b = 0, aacc = 0
      let taken = 0
      // bounded re-roll for the disc footprint: at most 4x the tap budget
      for (let i = 0; i < taps * 4 && taken < taps; i++) {
        const [jx, jy] = reedHash(Math.fround(gx + saltX[i]), Math.fround(gy + saltY[i]))
        if (disc && jx * jx + jy * jy > 1) continue
        taken++
        sampleMirrorBilinear(src, x + jx * rad, y + jy * rad, tap)
        r += tap[0]; g += tap[1]; b += tap[2]; aacc += tap[3]
      }
      const n = taken || 1
      const di = (y * W + x) * 4
      const invA = 1 / Math.max(aacc, 1e-5)
      out.data[di] = r * invA
      out.data[di + 1] = g * invA
      out.data[di + 2] = b * invA
      out.data[di + 3] = aacc / n
    }
  }
  return out
}

/**
 * Bilinear fetch with the shader's mirror fold, in pixel space.
 * Shader: tap = 1 - abs(fract(uv*0.5)*2 - 1), applied in [0,1] UV.
 */
function sampleMirrorBilinear(img: FloatImage, x: number, y: number, out: number[]): void {
  const { width: W, height: H, data } = img
  const u = mirror01((x + 0.5) / W) * W - 0.5
  const v = mirror01((y + 0.5) / H) * H - 0.5
  const x0 = Math.floor(u)
  const y0 = Math.floor(v)
  const fx = u - x0
  const fy = v - y0
  const x0c = clampInt(x0, W - 1)
  const x1c = clampInt(x0 + 1, W - 1)
  const y0c = clampInt(y0, H - 1)
  const y1c = clampInt(y0 + 1, H - 1)
  for (let c = 0; c < 4; c++) {
    const a = data[(y0c * W + x0c) * 4 + c]
    const b = data[(y0c * W + x1c) * 4 + c]
    const d = data[(y1c * W + x0c) * 4 + c]
    const e = data[(y1c * W + x1c) * 4 + c]
    out[c] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy
  }
}

function mirror01(t: number): number {
  const f = t * 0.5
  const fr = f - Math.floor(f)
  return 1 - Math.abs(fr * 2 - 1)
}
