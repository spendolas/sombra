/**
 * Phase 14 — is the supersampled ground truth actually CONVERGED, and what does
 * the converged look at the user's curvature 2.15 actually contain?
 *
 * Everything in the reeded-glass AA study is scored against a box supersample of
 * the node's own shader. A prior study noted that even 16x16 leaves RMSE
 * 3.0-6.1/255 at curvature 1.5, which — if it means the reference has not
 * converged — voids every ranking built on it. This phase settles that by
 * running a 4/8/16/32/64 ladder and reporting the residual between CONSECUTIVE
 * levels, on both a high-contrast stimulus and a nearly-flat one matched to the
 * user's scene.
 *
 * Design notes that matter for trusting the numbers:
 *
 *  - THE GT NODE IS THE SPLIT-DISABLED SHADER, not the working tree. Phase 12
 *    already measured that supersampling the shipped node box-filters its own
 *    seam-coverage split a second time, giving a GT up to 32 codes different
 *    from the published one. So the canonical reference here is the shipped
 *    shader with `rg_split_* = false` (phase 12 gate: byte-identical to the
 *    pre-AA node). The shipped-node ladder is ALSO run, so the size of that
 *    self-filtering divergence is a measured number in this report rather than
 *    an assumption.
 *
 *  - EVERY LEVEL IS TILED, so no level is limited by its own 8-bit write.
 *    A single N x N draw writes its average to rgba8unorm and quantises to
 *    +-0.5 code — a 0.29-code RMS floor, which is the same order as the 0.5-code
 *    convergence gate we want to test. So level N is accumulated on the CPU in
 *    f64 from T x T draws of (N/T) x (N/T) taps each, cutting the quantisation
 *    floor to 0.29/T codes. Gate C2 proves the tiled decomposition equals the
 *    single-draw one.
 *
 *  - ONLY THE LAST PASS IS SUPERSAMPLED. Pass 0 is the image blit; supersampling
 *    it too would change the source content per level and contaminate the very
 *    residual being measured.
 *
 * Stages:
 *   --gates    metric + wrapper validation (run this first; the rest depends on it)
 *   --ladder   the 4/8/16/32/64 convergence ladder
 *   --plates   target-look plates at 6x on a seam
 *   (no flag = all three)
 *
 * Run: npx tsx scripts/blur-bakeoff/phase14-gt-convergence.ts
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildReededGraph, type ReededConfig, type BuiltGraph } from './phase10-graph.ts'
import { createPhase10Rig, wrapSupersample, type Phase10Rig, type WgslPass } from './phase10-rig.ts'
import type { Rgba8 } from './lib/image.ts'
import { encodePng } from './lib/png.ts'

const REPO = process.cwd()
const OUT_DIR = path.join(REPO, 'reports', 'blur-bakeoff', 'phase14')

// ===========================================================================
// Frame geometry
// ===========================================================================

/**
 * 320 x 512 at dpr 1.5.
 *
 * Rib size on screen is set by `ribWidth * u_dpr`, NOT by the canvas size, so a
 * small canvas shows the same-scale ribs as the user's window — just fewer of
 * them. 320 device px = 2.67 rib periods at ribWidth 80 x dpr 1.5 (period 120
 * px), which is two full interior spans plus three seams. 512 rows = 59% of the
 * sine wave period (577 * 1.5 = 865.5 px), which sweeps the seam slope across
 * its whole range (cos phase 1.0 -> -0.83, through 0), so every seam angle the
 * scene contains is represented.
 *
 * dpr 1.5 = min(devicePixelRatio, 2) * ANIMATED_DPR_SCALE(0.75): the user's
 * graph is time-live, so this is the dpr their scene actually renders at.
 */
const W = 320
const H = 512
const DPR = 1.5

/** The user's Reeded Glass settings from `shaders/face dr.sombra`, verbatim. */
const USER_CFG: ReededConfig = {
  ribWidth: 80,
  ior: 1.65,
  curvature: 2.15,
  bow: 2.72,
  frost: 0,
  direction: 'vertical',
  ribType: 'wave',
  waveShape: 'sine',
  amplitude: 20,
  wavelength: 577,
  srt_scale: 1,
  srt_rotate: 0,
  srt_translateX: 0,
  srt_translateY: 0,
}

/** Node defaults — the config where 0% of the rib minifies. */
const DEFAULT_CFG: ReededConfig = {
  ribWidth: 80, ior: 1.5, curvature: 0.8, bow: 1, frost: 0,
  direction: 'vertical', ribType: 'straight',
  srt_scale: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
}

// ===========================================================================
// The closed-form derivative, for cross-checking which configs minify
// ===========================================================================

/**
 * L'(x) = 1 - A / (1 - k^2 x^2)^{3/2}, with x = 2*local - 1 in [-1, 1].
 * Mirrors REED_LENS_BODY: k = min(clamp(curvature, 0.01, 1), 0.99),
 * amp = curvature > 1 ? curvature : 1, A = (ior - 1) * amp * k * 0.5 * 2
 * (the 0.5 in `disp` and the 2 in dx/dlocal cancel to (ior-1)*amp*k).
 */
function lensDeriv(x: number, ior: number, curvature: number): number {
  const k = Math.min(Math.max(Math.min(curvature, 1), 0.01), 0.99)
  const amp = curvature > 1 ? curvature : 1
  const A = (ior - 1) * amp * k
  const s = Math.max(1 - k * k * x * x, 0.001)
  return 1 - A / Math.pow(s, 1.5)
}

/** Fraction of the rib where |L'| > 1 (minification -> aliasing), and max |L'|. */
function minifyStats(ior: number, curvature: number): { fracMinify: number; maxAbs: number; atCentre: number } {
  const N = 200001
  let n = 0
  let mx = 0
  for (let i = 0; i < N; i++) {
    const x = -1 + (2 * i) / (N - 1)
    const d = Math.abs(lensDeriv(x, ior, curvature))
    if (d > 1) n++
    if (d > mx) mx = d
  }
  return { fracMinify: n / N, maxAbs: mx, atCentre: lensDeriv(0, ior, curvature) }
}

// ===========================================================================
// Supersample wrapper — tiled, so no level is limited by its own 8-bit write
// ===========================================================================

const FRAG_SIG = /@fragment\s+fn\s+fs_main\s*\(\s*in\s*:\s*VertexOutput\s*\)\s*->\s*@location\(0\)\s*vec4f\s*\{/

/**
 * Box-supersample tile (tx, ty) of a T x T decomposition of the full N x N grid.
 *
 * Global sub-sample index gx = tx * n + sx with n = N / T, so the offsets are
 * exactly the ones the single-draw N x N wrapper would use — see gate C2.
 * v_uv.y is negated relative to position.y because v_uv is y-UP while
 * @builtin(position) is y-DOWN.
 */
function wrapSupersampleTile(code: string, N: number, T: number, tx: number, ty: number, w: number, h: number): string {
  if (N % T !== 0) throw new Error(`wrapSupersampleTile: N=${N} not divisible by T=${T}`)
  if (!FRAG_SIG.test(code)) throw new Error('phase14: fs_main signature not found; assembler output changed')
  const n = N / T
  const inner = code.replace(FRAG_SIG, 'fn sombra_frag_inner(in: VertexOutput) -> vec4f {')
  return `${inner}

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  var acc: vec4f = vec4f(0.0);
  let invN: f32 = 1.0 / f32(${N});
  for (var sy: i32 = 0; sy < ${n}; sy = sy + 1) {
    for (var sx: i32 = 0; sx < ${n}; sx = sx + 1) {
      let gx: f32 = f32(${tx * n} + sx);
      let gy: f32 = f32(${ty * n} + sy);
      let off = vec2f((gx + 0.5) * invN - 0.5, (gy + 0.5) * invN - 0.5);
      var s: VertexOutput;
      s.position = vec4f(in.position.x + off.x, in.position.y + off.y, in.position.z, in.position.w);
      s.v_uv = vec2f(in.v_uv.x + off.x / ${w.toFixed(1)}, in.v_uv.y - off.y / ${h.toFixed(1)});
      acc = acc + sombra_frag_inner(s);
    }
  }
  return acc * (1.0 / f32(${n * n}));
}
`
}

/** Tiles per axis for level N: keep taps/draw <= 64 and T >= 2 (quantisation floor 0.29/T codes). */
function tilesFor(N: number): number {
  if (N <= 2) return 1
  let T = 2
  while (N / T > 8) T *= 2
  return T
}

// ===========================================================================
// Float images (0..255 code units, RGBA) — the working representation
// ===========================================================================

interface FloatCodes { width: number; height: number; data: Float64Array }

function zeros(w: number, h: number): FloatCodes {
  return { width: w, height: h, data: new Float64Array(w * h * 4) }
}

function addInto(dst: FloatCodes, src: Rgba8, weight: number): void {
  const d = dst.data
  const s = src.data
  for (let i = 0; i < d.length; i++) d[i] += s[i] * weight
}

function toRgba8(f: FloatCodes): Rgba8 {
  const out = new Uint8ClampedArray(f.width * f.height * 4)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(f.data[i])
  return { width: f.width, height: f.height, data: out }
}

function fromRgba8(img: Rgba8): FloatCodes {
  const f = zeros(img.width, img.height)
  for (let i = 0; i < f.data.length; i++) f.data[i] = img.data[i]
  return f
}

// ===========================================================================
// Metrics
// ===========================================================================

interface Resid {
  /** mean over pixels of the max-of-RGB absolute difference, in 8-bit codes */
  meanMaxRgb: number
  /** RMS over pixels and RGB channels, in 8-bit codes */
  rmse: number
  p999: number
  max: number
  /** worst pixel location */
  at: [number, number]
  /** fraction of pixels whose max-RGB difference is >= 1 code */
  fracGe1: number
  fracGe8: number
}

const MARGIN = 6

/** Per-pixel max-of-RGB absolute difference, in codes, ignoring a frame margin. */
function diffField(a: FloatCodes, b: FloatCodes): Float64Array {
  if (a.width !== b.width || a.height !== b.height) throw new Error('diffField: size mismatch')
  const out = new Float64Array(a.width * a.height)
  for (let y = MARGIN; y < a.height - MARGIN; y++) {
    for (let x = MARGIN; x < a.width - MARGIN; x++) {
      const o = (y * a.width + x) * 4
      const d = Math.max(
        Math.abs(a.data[o] - b.data[o]),
        Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2]),
      )
      out[y * a.width + x] = d
    }
  }
  return out
}

function residual(a: FloatCodes, b: FloatCodes, mask?: Uint8Array | null): Resid {
  const f = diffField(a, b)
  let sum = 0
  let sq = 0
  let n = 0
  let mx = -1
  let at: [number, number] = [0, 0]
  let ge1 = 0
  let ge8 = 0
  const vals: number[] = []
  for (let y = MARGIN; y < a.height - MARGIN; y++) {
    for (let x = MARGIN; x < a.width - MARGIN; x++) {
      const i = y * a.width + x
      if (mask && !mask[i]) continue
      const d = f[i]
      sum += d
      n++
      vals.push(d)
      if (d >= 1) ge1++
      if (d >= 8) ge8++
      if (d > mx) { mx = d; at = [x, y] }
      const o = i * 4
      for (let c = 0; c < 3; c++) {
        const e = a.data[o + c] - b.data[o + c]
        sq += e * e
      }
    }
  }
  vals.sort((p, q) => p - q)
  const p999 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.999))] : 0
  return {
    meanMaxRgb: n ? sum / n : 0,
    rmse: n ? Math.sqrt(sq / (n * 3)) : 0,
    p999, max: mx < 0 ? 0 : mx, at,
    fracGe1: n ? ge1 / n : 0,
    fracGe8: n ? ge8 / n : 0,
  }
}

/** Rec.709 luma in code units. */
function luma(f: FloatCodes, x: number, y: number): number {
  const o = (y * f.width + x) * 4
  return 0.2126 * f.data[o] + 0.7152 * f.data[o + 1] + 0.0722 * f.data[o + 2]
}

interface Span { min: number; max: number; span: number; p05: number; p995: number; robustSpan: number; mean: number }

function lumaSpan(f: FloatCodes): Span {
  const vals: number[] = []
  for (let y = MARGIN; y < f.height - MARGIN; y++) {
    for (let x = MARGIN; x < f.width - MARGIN; x++) vals.push(luma(f, x, y))
  }
  vals.sort((a, b) => a - b)
  const q = (p: number): number => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * p)))]
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  return {
    min: vals[0], max: vals[vals.length - 1], span: vals[vals.length - 1] - vals[0],
    p05: q(0.005), p995: q(0.995), robustSpan: q(0.995) - q(0.005), mean,
  }
}

// ===========================================================================
// Stimuli
// ===========================================================================

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

/** Separable gaussian on 8-bit codes, edge-clamped, float intermediate. */
function gaussianBlurCodes(img: Rgba8, sigma: number): Rgba8 {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float64Array(2 * r + 1)
  let ks = 0
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; ks += v }
  for (let i = 0; i < k.length; i++) k[i] /= ks
  const { width: w, height: h } = img
  const tmp = new Float64Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0]
      for (let i = -r; i <= r; i++) {
        const sx = Math.max(0, Math.min(w - 1, x + i))
        const o = (y * w + sx) * 4
        const kw = k[i + r]
        for (let c = 0; c < 4; c++) acc[c] += img.data[o + c] * kw
      }
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) tmp[o + c] = acc[c]
    }
  }
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0]
      for (let i = -r; i <= r; i++) {
        const sy = Math.max(0, Math.min(h - 1, y + i))
        const o = (sy * w + x) * 4
        const kw = k[i + r]
        for (let c = 0; c < 4; c++) acc[c] += tmp[o + c] * kw
      }
      const o = (y * w + x) * 4
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(acc[c])
      out[o + 3] = 255
    }
  }
  return { width: w, height: h, data: out }
}

/** Affine-remap RGB so the luma p0.5..p99.5 range spans `targetSpan` codes about `targetMean`. */
function compressToSpan(img: Rgba8, targetSpan: number, targetMean: number): Rgba8 {
  const vals: number[] = []
  for (let i = 0; i < img.data.length; i += 4) {
    vals.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2])
  }
  const sorted = [...vals].sort((a, b) => a - b)
  const lo = sorted[Math.floor(sorted.length * 0.005)]
  const hi = sorted[Math.floor(sorted.length * 0.995)]
  const g = targetSpan / Math.max(hi - lo, 1e-6)
  const mid = (lo + hi) / 2
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((img.data[i + c] - mid) * g + targetMean)
    out[i + 3] = 255
  }
  return { width: img.width, height: img.height, data: out }
}

type StimId = 'hicon' | 'flat'

async function loadStimuli(rig: Phase10Rig): Promise<Record<StimId, Rgba8>> {
  const bytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'stuff', '5468102179_8f885a1744_o.jpg')))
  const decoded = await rig.decodeImage(bytes, 'image/jpeg', 2048)
  const hicon = coverCrop(decoded, W, H)
  // The user's chain is blur(radius 51) then warp(srt_scale 4.35), so the
  // content the reeded glass samples varies over ~51/3 * 4.35 = 74 device px.
  // Blur to that scale, then squeeze the range to the measured ~30-code span.
  const flat = compressToSpan(gaussianBlurCodes(hicon, 74 / 3), 30, 128)
  return { hicon, flat }
}

// ===========================================================================
// Node variants: SHIPPED (working tree) and NOSPLIT (canonical GT)
// ===========================================================================

/** phase 12's patch, re-declared here so phase 12 is not read-modify-written. */
const NOSPLIT_RE = /(rg_split_\w+(?::\s*bool)?\s*=\s*)abs\([^;]*;/

type Variant = 'shipped' | 'nosplit'

function applyVariant(code: string, v: Variant): string {
  if (v === 'shipped') return code
  if (!NOSPLIT_RE.test(code)) throw new Error('nosplit: rg_split assignment not found in emitted WGSL')
  const out = code.replace(NOSPLIT_RE, '$1false;')
  if ((out.match(/rg_split_\w+(?::\s*bool)?\s*=\s*false;/) ?? []).length !== 1) {
    throw new Error('nosplit: patch did not apply exactly once')
  }
  return out
}

/**
 * Apply the variant to the LAST pass only. Pass 0 is the image blit and carries
 * no `rg_split_*`, so patching it would (correctly) throw.
 */
function variantPasses(g: BuiltGraph, v: Variant): WgslPass[] {
  const last = g.passes.length - 1
  return g.passes.map((p, i) => (i === last ? { ...p, shaderCode: applyVariant(p.shaderCode, v) } : { ...p }))
}

const graphCache = new Map<string, BuiltGraph>()
function graphFor(cfg: ReededConfig): BuiltGraph {
  const key = JSON.stringify(cfg)
  let g = graphCache.get(key)
  if (!g) { g = buildReededGraph(cfg, W / H); graphCache.set(key, g) }
  return g
}

/**
 * Render `cfg` at supersample level N. Only the LAST pass is supersampled;
 * pass 0 (the image blit) stays 1:1 so the source content is level-independent.
 * Accumulated on the CPU in f64 across T x T tile draws.
 */
async function renderLevel(
  rig: Phase10Rig, stim: Rgba8, cfg: ReededConfig, variant: Variant, N: number,
  opts?: { forceT?: number },
): Promise<FloatCodes> {
  const g = graphFor(cfg)
  const last = g.passes.length - 1
  const T = opts?.forceT ?? (N === 1 ? 1 : tilesFor(N))
  const acc = zeros(W, H)
  for (let ty = 0; ty < T; ty++) {
    for (let tx = 0; tx < T; tx++) {
      const passes: WgslPass[] = variantPasses(g, variant).map((p, i) => {
        if (i !== last) return p
        const code = N === 1 ? p.shaderCode : wrapSupersampleTile(p.shaderCode, N, T, tx, ty, W, H)
        return { ...p, shaderCode: code }
      })
      const img = await rig.run({ width: W, height: H, dpr: DPR, passes, images: { [g.imageSampler]: stim } })
      addInto(acc, img, 1 / (T * T))
    }
  }
  return acc
}

// ===========================================================================
// PNG helpers
// ===========================================================================

function writePng(name: string, img: Rgba8): string {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const p = path.join(OUT_DIR, name)
  fs.writeFileSync(p, encodePng(img))
  return p
}

function cropRgba(img: Rgba8, x0: number, y0: number, w: number, h: number): Rgba8 {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(img.height - 1, y0 + y))
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(img.width - 1, x0 + x))
      const s = (sy * img.width + sx) * 4
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = img.data[s + c]
    }
  }
  return { width: w, height: h, data: out }
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

// ===========================================================================
// Seam-track analysis — the quantitative form of "does it staircase?"
// ===========================================================================

/**
 * Sub-pixel x of the strongest luma gradient in each row of a window.
 *
 * A staircased contour reads as flat runs of 2-4 rows at the same integer x with
 * a 1 px lateral jump between them; a correctly-filtered contour advances by a
 * fraction of a pixel per row. Two numbers separate them:
 *   `jumpMax`   — the largest row-to-row step in the sub-pixel position (px)
 *   `flatRunP50`— median length, in rows, of a run at the same ROUNDED x
 * A smooth contour has jumpMax ~ its true slope and flatRunP50 ~ 1/slope with no
 * hard steps; a staircase has jumpMax >= 1 px with long flat runs between.
 */
interface SeamTrack {
  xs: number[]
  peakCodes: number[]
  jumpMax: number
  jumpP95: number
  flatRunP50: number
  flatRunMax: number
  /** mean |second difference| of the sub-pixel track, px — 0 for a straight contour */
  curvature2nd: number
}

function seamTrack(f: FloatCodes, x0: number, x1: number, y0: number, y1: number): SeamTrack {
  const xs: number[] = []
  const peaks: number[] = []
  for (let y = y0; y < y1; y++) {
    // central-difference |gradient|, argmax, then parabolic sub-pixel refine.
    // argmax (not a centroid) because the artefact is a caustic PAIR and a
    // centroid would slide between the two edges instead of tracking one.
    let bi = x0 + 1
    let bg = -1
    for (let x = x0 + 1; x < x1 - 1; x++) {
      const g = Math.abs(luma(f, x + 1, y) - luma(f, x - 1, y)) * 0.5
      if (g > bg) { bg = g; bi = x }
    }
    const gm = Math.abs(luma(f, bi, y) - luma(f, Math.max(x0, bi - 2), y)) * 0.5
    const gp = Math.abs(luma(f, Math.min(x1 - 1, bi + 2), y) - luma(f, bi, y)) * 0.5
    const den = gm - 2 * bg + gp
    const sub = Math.abs(den) > 1e-9 ? Math.max(-1, Math.min(1, 0.5 * (gm - gp) / den)) : 0
    xs.push(bi + sub)
    peaks.push(bg)
  }
  let jumpMax = 0
  const jumps: number[] = []
  for (let i = 1; i < xs.length; i++) {
    const d = Math.abs(xs[i] - xs[i - 1])
    if (Number.isFinite(d)) { jumps.push(d); if (d > jumpMax) jumpMax = d }
  }
  jumps.sort((a, b) => a - b)
  let second = 0
  let n2 = 0
  for (let i = 2; i < xs.length; i++) {
    const d = Math.abs(xs[i] - 2 * xs[i - 1] + xs[i - 2])
    if (Number.isFinite(d)) { second += d; n2++ }
  }
  const runs: number[] = []
  let cur = 1
  for (let i = 1; i < xs.length; i++) {
    if (Math.round(xs[i]) === Math.round(xs[i - 1])) cur++
    else { runs.push(cur); cur = 1 }
  }
  runs.push(cur)
  const sortedRuns = [...runs].sort((a, b) => a - b)
  return {
    xs: xs.map((v) => +v.toFixed(3)),
    peakCodes: peaks.map((v) => +v.toFixed(2)),
    jumpMax: +jumpMax.toFixed(3),
    jumpP95: +(jumps.length ? jumps[Math.floor(jumps.length * 0.95)] : 0).toFixed(3),
    flatRunP50: sortedRuns[Math.floor(sortedRuns.length / 2)],
    flatRunMax: sortedRuns[sortedRuns.length - 1],
    curvature2nd: +(n2 ? second / n2 : 0).toFixed(4),
  }
}

/**
 * The measurement noise floor, in code-rmse: 0.2887 / T, from the 8-bit write of
 * each of the T x T tile draws. Empirically confirmed to 3 s.f. by the
 * `nodeDefaults / hicon` control, whose TRUE convergence error is ~0 at every
 * level (0% of the rib minifies, straight ribs) and whose measured |GTn - GT64|
 * rmse plateaus at 0.143 for T=2 (predicted 0.144) and 0.072 for T=4 (0.072).
 */
function noiseFloorRms(N: number): number {
  return 0.2887 / (N === 1 ? 1 : tilesFor(N))
}

/** Quadrature-subtract the measurement floor from an observed rmse. */
function floorCorrected(obsRms: number, na: number, nb: number): number {
  const fa = na === 1 ? 0 : noiseFloorRms(na)
  const fb = nb === 1 ? 0 : noiseFloorRms(nb)
  const f2 = fa * fa + fb * fb
  return Math.sqrt(Math.max(obsRms * obsRms - f2, 0))
}

/** Local-contrast normalise a crop so a 30-code-span region is actually visible. */
function normaliseTo(img: Rgba8, lo: number, hi: number): Rgba8 {
  const g = 255 / Math.max(hi - lo, 1e-6)
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((img.data[i + c] - lo) * g)
    out[i + 3] = 255
  }
  return { width: img.width, height: img.height, data: out }
}

/** Plot one or more luma profiles as a PNG so the shape can be read back visually. */
function profilePlot(series: Array<{ label: string; vals: number[]; rgb: [number, number, number] }>, hpx: number): Rgba8 {
  const wpx = series[0].vals.length
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) for (const v of s.vals) { if (v < lo) lo = v; if (v > hi) hi = v }
  const pad = (hi - lo) * 0.08 + 0.5
  lo -= pad; hi += pad
  const out = new Uint8ClampedArray(wpx * hpx * 4)
  for (let i = 0; i < out.length; i += 4) { out[i] = 16; out[i + 1] = 16; out[i + 2] = 26; out[i + 3] = 255 }
  const put = (x: number, y: number, rgb: [number, number, number]): void => {
    if (x < 0 || x >= wpx || y < 0 || y >= hpx) return
    const o = (y * wpx + x) * 4
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]
  }
  for (const s of series) {
    let prevY = -1
    for (let x = 0; x < wpx; x++) {
      const y = Math.round((hi - s.vals[x]) / (hi - lo) * (hpx - 1))
      if (prevY >= 0) {
        const step = y > prevY ? 1 : -1
        for (let yy = prevY; yy !== y; yy += step) put(x, yy, s.rgb)
      }
      put(x, y, s.rgb)
      prevY = y
    }
  }
  return { width: wpx, height: hpx, data: out }
}

// ===========================================================================
// Gates
// ===========================================================================

interface Gate { id: string; what: string; good: string; bad: string; pass: boolean }

async function runGates(rig: Phase10Rig, stimuli: Record<StimId, Rgba8>): Promise<Gate[]> {
  const gates: Gate[] = []
  const add = (id: string, what: string, good: string, bad: string, pass: boolean): void => {
    gates.push({ id, what, good, bad, pass })
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${id}  ${what}\n        good: ${good}\n        bad:  ${bad}`)
  }

  // C0 — N=1 wrapper is a no-op. The offsets at N=1 are exactly zero, so the
  // wrapped shader must be pixel-identical to the unwrapped one. If it is not,
  // the wrapper perturbs geometry and every level is suspect.
  {
    const g = graphFor(USER_CFG)
    const last = g.passes.length - 1
    const plain = await rig.run({
      width: W, height: H, dpr: DPR,
      passes: variantPasses(g, 'nosplit'),
      images: { [g.imageSampler]: stimuli.hicon },
    })
    const wrapped = await rig.run({
      width: W, height: H, dpr: DPR,
      passes: variantPasses(g, 'nosplit').map((p, i) => (
        i === last ? { ...p, shaderCode: wrapSupersampleTile(p.shaderCode, 1, 1, 0, 0, W, H) } : p
      )),
      images: { [g.imageSampler]: stimuli.hicon },
    })
    const r = residual(fromRgba8(plain), fromRgba8(wrapped))
    add('C0', 'N=1 tile wrapper is pixel-identical to the unwrapped shader',
      `max ${r.max.toFixed(3)} codes`, 'any nonzero means the wrapper shifts geometry', r.max === 0)
  }

  // C1 — the reference wrapper in phase10-rig and this file's tiled wrapper at
  // T=1 must agree. Different text, same grid; this is the cross-check that the
  // tiled offsets were derived correctly.
  {
    const g = graphFor(USER_CFG)
    const last = g.passes.length - 1
    const vp = variantPasses(g, 'nosplit')
    const mk = (code: string): WgslPass[] => vp.map((p, i) => (i === last ? { ...p, shaderCode: code } : p))
    const base = vp[last].shaderCode
    const a = await rig.run({ width: W, height: H, dpr: DPR, passes: mk(wrapSupersample(base, 8, W, H)), images: { [g.imageSampler]: stimuli.hicon } })
    const b = await rig.run({ width: W, height: H, dpr: DPR, passes: mk(wrapSupersampleTile(base, 8, 1, 0, 0, W, H)), images: { [g.imageSampler]: stimuli.hicon } })
    const r = residual(fromRgba8(a), fromRgba8(b))
    add('C1', 'tiled wrapper at T=1 equals phase10-rig wrapSupersample (N=8)',
      `max ${r.max.toFixed(3)} codes`, '> 1 code would mean the grids differ', r.max <= 1)
  }

  // C2a — the single-draw 8-bit write quantisation we are TILING TO ESCAPE.
  // 16x16 as one draw rounds its 256-tap average to one integer code; as 2x2
  // tiles of 8x8 it is the f64 mean of four rounded quarters. The two must agree
  // structurally (max <= 1 code, which is exactly 0.5 + 0.5 of rounding) but the
  // mean difference is ~0.25-0.5 codes, and that is the whole point: a
  // single-draw ladder cannot resolve a 0.5-code convergence criterion because
  // its own output noise is that size.
  {
    const single = await renderLevel(rig, stimuli.hicon, USER_CFG, 'nosplit', 16, { forceT: 1 })
    const tiled = await renderLevel(rig, stimuli.hicon, USER_CFG, 'nosplit', 16, { forceT: 2 })
    const r = residual(single, tiled)
    add('C2a', 'single-draw N=16 vs 2x2-tiled N=16: pure 8-bit write quantisation',
      `mean ${r.meanMaxRgb.toFixed(4)} max ${r.max.toFixed(3)} codes (max 1.0 == 0.5+0.5 rounding)`,
      'max > 1 code would mean the tile offsets differ, not just the rounding',
      r.max <= 1 && r.meanMaxRgb > 0.15 && r.meanMaxRgb < 0.55)
  }

  // C2b — both sides tiled, so the quantisation floor drops as 1/T. T=2 has a
  // 0.144-code RMS floor and T=4 a 0.072-code one, so their difference must be
  // well under the 0.5-code gate. This is the gate that actually proves the tile
  // offsets are right (C2a can pass on rounding alone).
  {
    const t2 = await renderLevel(rig, stimuli.hicon, USER_CFG, 'nosplit', 16, { forceT: 2 })
    const t4 = await renderLevel(rig, stimuli.hicon, USER_CFG, 'nosplit', 16, { forceT: 4 })
    const r = residual(t2, t4)
    add('C2b', '2x2-tiled N=16 == 4x4-tiled N=16 (same grid, lower quantisation floor)',
      `mean ${r.meanMaxRgb.toFixed(4)} max ${r.max.toFixed(3)} codes`,
      'mean > 0.2 would mean tile (tx,ty) maps to the wrong sub-grid', r.meanMaxRgb < 0.2 && r.max <= 1)
  }

  // C3 — no nondeterminism floor: the same spec rendered twice must be identical.
  // Without this, any residual could be GPU run-to-run variation.
  {
    const a = await renderLevel(rig, stimuli.hicon, USER_CFG, 'nosplit', 8)
    const b = await renderLevel(rig, stimuli.hicon, USER_CFG, 'nosplit', 8)
    const r = residual(a, b)
    add('C3', 'same level rendered twice is bit-identical (no run-to-run floor)',
      `max ${r.max.toFixed(4)} codes`, 'any nonzero would put a noise floor under every residual', r.max === 0)
  }

  // C4 — KNOWN-BAD the metric must see: a supersample grid that spans only the
  // middle HALF of the pixel. It still converges, but to the wrong integral, so
  // a metric that cannot separate it from the correct grid cannot be trusted to
  // separate a correct fix from a wrong one.
  {
    const g = graphFor(USER_CFG)
    const last = g.passes.length - 1
    const vp = variantPasses(g, 'nosplit')
    const mk = (code: string): WgslPass[] => vp.map((p, i) => (i === last ? { ...p, shaderCode: code } : p))
    const good = await rig.run({ width: W, height: H, dpr: DPR, passes: mk(wrapSupersampleTile(vp[last].shaderCode, 8, 1, 0, 0, W, H)), images: { [g.imageSampler]: stimuli.hicon } })
    const bad = await rig.run({ width: W, height: H, dpr: DPR, passes: mk(wrapHalfFootprint(vp[last].shaderCode, 8, W, H)), images: { [g.imageSampler]: stimuli.hicon } })
    const r = residual(fromRgba8(good), fromRgba8(bad))
    add('C4', 'metric SEES a half-footprint (wrong support) supersample grid',
      `mean ${r.meanMaxRgb.toFixed(3)} max ${r.max.toFixed(0)} codes`,
      'C0/C1/C2b read <= 0.2 on correct grids', r.meanMaxRgb > 1)
  }

  // C5 — KNOWN-BAD, fine-grained: phase10-rig's deliberately y-flipped v_uv
  // wrapper. For vertical ribs this only mis-phases the sine wave field by
  // ~0.11 px of main axis, so it is a much smaller error than C4 — and the
  // metric still resolves it. That brackets the sensitivity from both ends.
  {
    const g = graphFor(USER_CFG)
    const last = g.passes.length - 1
    const vp = variantPasses(g, 'nosplit')
    const mk = (code: string): WgslPass[] => vp.map((p, i) => (i === last ? { ...p, shaderCode: code } : p))
    const good = await rig.run({ width: W, height: H, dpr: DPR, passes: mk(wrapSupersample(vp[last].shaderCode, 8, W, H, false)), images: { [g.imageSampler]: stimuli.hicon } })
    const bad = await rig.run({ width: W, height: H, dpr: DPR, passes: mk(wrapSupersample(vp[last].shaderCode, 8, W, H, true)), images: { [g.imageSampler]: stimuli.hicon } })
    const r = residual(fromRgba8(good), fromRgba8(bad))
    add('C5', 'metric SEES the known-bad y-flipped v_uv wrapper (a ~0.11 px rib phase error)',
      `mean ${r.meanMaxRgb.toFixed(3)} max ${r.max.toFixed(0)} codes`,
      'correct grids read <= 0.2 mean', r.meanMaxRgb > 0.1)
  }

  // C6 — stimulus spans. The flat one has to actually be flat or it does not
  // represent the user's scene, and the high-contrast one has to actually be
  // high-contrast or "test both" is vacuous.
  {
    const sf = lumaSpan(fromRgba8(stimuli.flat))
    const sh = lumaSpan(fromRgba8(stimuli.hicon))
    add('C6', 'stimulus luma spans: flat ~30 codes, hicon near full range',
      `flat p0.5-p99.5 ${sf.robustSpan.toFixed(1)} (full ${sf.span.toFixed(1)}), hicon ${sh.robustSpan.toFixed(1)} (full ${sh.span.toFixed(1)}) codes`,
      'flat robustSpan outside 25..35 would not represent the scene',
      sf.robustSpan > 25 && sf.robustSpan < 35 && sh.robustSpan > 150)
  }

  // C7 — the optical identity really is an identity. ior 1.0 zeroes reedLens's
  // displacement AND its sagitta, so the node degenerates to a blit of pass 0.
  // Compared against the bypass graph (image -> fragment output, no reeded
  // glass at all) it must agree to the rgba8unorm round trip.
  {
    const idCfg: ReededConfig = { ...USER_CFG, ior: 1.0, bow: 0 }
    const gi = graphFor(idCfg)
    const one = await rig.run({
      width: W, height: H, dpr: DPR, passes: variantPasses(gi, 'nosplit'),
      images: { [gi.imageSampler]: stimuli.hicon },
    })
    const gb = buildReededGraph(idCfg, W / H, { bypass: true })
    const byp = await rig.run({
      width: W, height: H, dpr: DPR, passes: gb.passes, images: { [gb.imageSampler]: stimuli.hicon },
    })
    const r = residual(fromRgba8(one), fromRgba8(byp))
    add('C7', 'ior 1.0 / bow 0 is optically an identity: 1 tap == the bypass graph',
      `mean ${r.meanMaxRgb.toFixed(4)} max ${r.max.toFixed(0)} codes`,
      'a nonzero delta would mean the "identity" still moves rays', r.max <= 1)
  }

  return gates
}

/**
 * C4's known-bad: the same N x N box, but spanning only the middle half of the
 * pixel ([-0.25, 0.25] instead of [-0.5, 0.5]). Converges, to the wrong answer.
 */
function wrapHalfFootprint(code: string, N: number, w: number, h: number): string {
  if (!FRAG_SIG.test(code)) throw new Error('phase14: fs_main signature not found')
  const inner = code.replace(FRAG_SIG, 'fn sombra_frag_inner(in: VertexOutput) -> vec4f {')
  return `${inner}

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  var acc: vec4f = vec4f(0.0);
  let inv: f32 = 1.0 / f32(${N});
  for (var sy: i32 = 0; sy < ${N}; sy = sy + 1) {
    for (var sx: i32 = 0; sx < ${N}; sx = sx + 1) {
      let off = 0.5 * vec2f((f32(sx) + 0.5) * inv - 0.5, (f32(sy) + 0.5) * inv - 0.5);
      var s: VertexOutput;
      s.position = vec4f(in.position.x + off.x, in.position.y + off.y, in.position.z, in.position.w);
      s.v_uv = vec2f(in.v_uv.x + off.x / ${w.toFixed(1)}, in.v_uv.y - off.y / ${h.toFixed(1)});
      acc = acc + sombra_frag_inner(s);
    }
  }
  return acc * (inv * inv);
}
`
}

/**
 * The BOX-PREFILTER PEDESTAL, measured — not a gate, a number later phases need.
 *
 * Box-supersampling ANY resampling shader convolves the result with a 1-device-px
 * box, because each sub-sample bilinearly interpolates the source at a sub-pixel
 * offset. At the optical identity that is the ENTIRE difference between the 1-tap
 * render and the 64x64 reference: no aliasing exists there at all. So this is the
 * part of every |candidate - GT| number in this study that is prefilter softening
 * rather than antialiasing, and it is the floor below which the two cannot be
 * told apart.
 */
async function pedestal(rig: Phase10Rig, stimuli: Record<StimId, Rgba8>): Promise<Record<string, unknown>> {
  const idCfg: ReededConfig = { ...USER_CFG, ior: 1.0, bow: 0 }
  const out: Record<string, unknown> = {}
  for (const stim of ['hicon', 'flat'] as StimId[]) {
    const one = await renderLevel(rig, stimuli[stim], idCfg, 'nosplit', 1)
    const gt = await renderLevel(rig, stimuli[stim], idCfg, 'nosplit', 64)
    const g32 = await renderLevel(rig, stimuli[stim], idCfg, 'nosplit', 32)
    out[stim] = {
      oneTapVsGt64: residual(one, gt),
      gt32VsGt64: residual(g32, gt),
    }
    const r = out[stim] as { oneTapVsGt64: Resid; gt32VsGt64: Resid }
    console.log(`  ${stim.padEnd(6)} identity pedestal |1tap - GT64| ${fmtResid(r.oneTapVsGt64)}`)
    console.log(`  ${stim.padEnd(6)}   ...and it CONVERGES: |GT32 - GT64| ${fmtResid(r.gt32VsGt64)}`)
  }
  return out
}

// ===========================================================================
// The ladder
// ===========================================================================

const LEVELS = [1, 4, 8, 16, 32, 64]

interface LadderRow {
  config: string
  stimulus: StimId
  variant: Variant
  cfg: ReededConfig
  minify: { fracMinify: number; maxAbs: number; atCentre: number }
  spans: Record<string, Span>
  /** consecutive-level residuals, keyed "4->8" etc. */
  steps: Array<{ from: number; to: number; all: Resid; band: Resid | null; quantFloorRms: number
    allRmseCorr: number; bandRmseCorr: number | null }>
  /** |L_N - L_64| for each N, all-pixel */
  vsFinest: Array<{ n: number; all: Resid; band: Resid | null; allRmseCorr: number; bandRmseCorr: number | null }>
  bandPx: number
  /** observed convergence order from the last two steps, and the Richardson tail */
  order: number | null
  richardsonTail: number | null
  converged: { level: number | null; criterion: string }
}

function ladderKey(cfgId: string, stim: StimId, variant: Variant): string {
  return `${cfgId}|${stim}|${variant}`
}

async function runLadder(
  rig: Phase10Rig, stimuli: Record<StimId, Rgba8>,
  combos: Array<{ id: string; cfg: ReededConfig; stim: StimId; variant: Variant }>,
): Promise<{ rows: LadderRow[]; images: Map<string, Map<number, FloatCodes>> }> {
  const rows: LadderRow[] = []
  const images = new Map<string, Map<number, FloatCodes>>()

  for (const combo of combos) {
    const key = ladderKey(combo.id, combo.stim, combo.variant)
    const byLevel = new Map<number, FloatCodes>()
    const spans: Record<string, Span> = {}
    console.log(`\n--- ladder ${key} ---`)
    for (const N of LEVELS) {
      const t0 = Date.now()
      const img = await renderLevel(rig, stimuli[combo.stim], combo.cfg, combo.variant, N)
      byLevel.set(N, img)
      spans[`N${N}`] = lumaSpan(img)
      const T = N === 1 ? 1 : tilesFor(N)
      console.log(`  N=${String(N).padStart(2)}  T=${T}  ${((Date.now() - t0) / 1000).toFixed(1)} s  ` +
        `luma span ${spans[`N${N}`].span.toFixed(1)} (p0.5-p99.5 ${spans[`N${N}`].robustSpan.toFixed(1)}) codes`)
    }
    images.set(key, byLevel)

    // error-bearing band: |1 tap - finest| >= 8 codes, the published definition
    const finest = byLevel.get(64)!
    const oneTap = byLevel.get(1)!
    const bandField = diffField(oneTap, finest)
    const band = new Uint8Array(W * H)
    let bandPx = 0
    for (let i = 0; i < band.length; i++) if (bandField[i] >= 8) { band[i] = 1; bandPx++ }

    const steps: LadderRow['steps'] = []
    const ss = LEVELS.filter((n) => n > 1)
    for (let i = 0; i + 1 < ss.length; i++) {
      const from = ss[i]
      const to = ss[i + 1]
      const qa = 0.2887 / (from === 1 ? 1 : tilesFor(from))
      const qb = 0.2887 / (to === 1 ? 1 : tilesFor(to))
      const sAll = residual(byLevel.get(from)!, byLevel.get(to)!)
      const sBand = bandPx > 0 ? residual(byLevel.get(from)!, byLevel.get(to)!, band) : null
      steps.push({
        from, to, all: sAll, band: sBand,
        quantFloorRms: Math.sqrt(qa * qa + qb * qb),
        allRmseCorr: floorCorrected(sAll.rmse, from, to),
        bandRmseCorr: sBand ? floorCorrected(sBand.rmse, from, to) : null,
      })
    }
    const vsFinest = LEVELS.filter((n) => n !== 64).map((n) => {
      const a = residual(byLevel.get(n)!, finest)
      const b = bandPx > 0 ? residual(byLevel.get(n)!, finest, band) : null
      return {
        n, all: a, band: b,
        allRmseCorr: floorCorrected(a.rmse, n, 64),
        bandRmseCorr: b ? floorCorrected(b.rmse, n, 64) : null,
      }
    })

    // observed order p from the last two consecutive-level RMSEs
    let order: number | null = null
    let richardsonTail: number | null = null
    if (steps.length >= 2) {
      const r1 = steps[steps.length - 2].allRmseCorr
      const r2 = steps[steps.length - 1].allRmseCorr
      if (r1 > 0 && r2 > 0) {
        order = Math.log2(r1 / r2)
        // |I_inf - I_64| ~ r2 / (2^p - 1)
        const denom = Math.pow(2, Math.max(order, 0.05)) - 1
        richardsonTail = r2 / denom
      }
    }

    // convergence: the first level N whose step to 2N has mean max-RGB < 0.5 codes
    let convLevel: number | null = null
    for (const st of steps) {
      const v = st.bandRmseCorr ?? st.allRmseCorr
      if (v < 0.5) { convLevel = st.to; break }
    }

    rows.push({
      config: combo.id, stimulus: combo.stim, variant: combo.variant, cfg: combo.cfg,
      minify: minifyStats(combo.cfg.ior ?? 1.5, combo.cfg.curvature ?? 0.8),
      spans, steps, vsFinest, bandPx, order, richardsonTail,
      converged: { level: convLevel, criterion: 'floor-corrected rmse of the residual to the next level < 0.5 codes, on the error-bearing band where one exists' },
    })
  }
  return { rows, images }
}

// ===========================================================================
// main
// ===========================================================================

function fmtResid(r: Resid): string {
  return `mean ${r.meanMaxRgb.toFixed(3)}  rmse ${r.rmse.toFixed(3)}  p99.9 ${r.p999.toFixed(2)}  max ${r.max.toFixed(2)}`
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const want = (s: string): boolean => args.length === 0 || args.includes(s)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const rig = await createPhase10Rig()
  console.log(`adapter: ${rig.adapterInfo}`)
  console.log(`frame: ${W}x${H} device px, u_dpr ${DPR}`)

  const out: Record<string, unknown> = {
    adapter: rig.adapterInfo, frame: { W, H, dpr: DPR }, head: 'aa082c0',
    userCfg: USER_CFG, levels: LEVELS,
  }

  try {
    const stimuli = await loadStimuli(rig)
    writePng('stimulus-hicon.png', stimuli.hicon)
    writePng('stimulus-flat.png', stimuli.flat)
    out.stimulusSpans = {
      hicon: lumaSpan(fromRgba8(stimuli.hicon)),
      flat: lumaSpan(fromRgba8(stimuli.flat)),
    }

    // derivative table — which configs minify at all
    const curvs = [0.8, 1.0, 1.5, 2.15]
    out.derivTable = curvs.map((c) => ({ curvature: c, ior: USER_CFG.ior, ...minifyStats(USER_CFG.ior!, c) }))
    out.derivDefaults = { curvature: 0.8, ior: 1.5, ...minifyStats(1.5, 0.8) }
    console.log('\n=== closed-form L\' at ior 1.65 ===')
    for (const r of out.derivTable as Array<{ curvature: number; fracMinify: number; maxAbs: number; atCentre: number }>) {
      console.log(`  curvature ${r.curvature.toFixed(2)}  L'(0) ${r.atCentre.toFixed(4)}  ` +
        `minifying ${(r.fracMinify * 100).toFixed(1)}% of the rib  max|L'| ${r.maxAbs.toFixed(1)}`)
    }
    const dd = out.derivDefaults as { fracMinify: number; maxAbs: number; atCentre: number }
    console.log(`  NODE DEFAULTS ior 1.5 curvature 0.8:  L'(0) ${dd.atCentre.toFixed(4)}  ` +
      `minifying ${(dd.fracMinify * 100).toFixed(2)}% max|L'| ${dd.maxAbs.toFixed(3)}`)

    if (want('--gates')) {
      console.log('\n=== gates ===')
      const gates = await runGates(rig, stimuli)
      out.gates = gates
      console.log('\n=== box-prefilter pedestal (NOT a gate — a number later phases need) ===')
      out.pedestal = await pedestal(rig, stimuli)
      fs.writeFileSync(path.join(OUT_DIR, 'phase14.json'), JSON.stringify(out, null, 2))
      if (gates.some((g) => !g.pass)) {
        console.error('\nGATE FAILURE — the ladder below is not trustworthy. Stopping.')
        process.exitCode = 1
        return
      }
    }

    let images = new Map<string, Map<number, FloatCodes>>()
    if (want('--ladder')) {
      const combos: Array<{ id: string; cfg: ReededConfig; stim: StimId; variant: Variant }> = []
      for (const stim of ['hicon', 'flat'] as StimId[]) {
        for (const c of curvs) {
          combos.push({ id: `curv${String(c).replace('.', 'p')}`, cfg: { ...USER_CFG, curvature: c }, stim, variant: 'nosplit' })
        }
        combos.push({ id: 'nodeDefaults', cfg: DEFAULT_CFG, stim, variant: 'nosplit' })
        combos.push({ id: 'curv2p15', cfg: { ...USER_CFG }, stim, variant: 'shipped' })
      }
      const res = await runLadder(rig, stimuli, combos)
      images = res.images
      out.ladder = res.rows

      console.log('\n=== consecutive-level residuals (all pixels, 8-bit codes) ===')
      for (const r of res.rows) {
        console.log(`\n${r.config} / ${r.stimulus} / ${r.variant}   ` +
          `minify ${(r.minify.fracMinify * 100).toFixed(1)}% of rib, max|L'| ${r.minify.maxAbs.toFixed(1)}   ` +
          `band(|1tap-GT64|>=8) ${r.bandPx} px (${(100 * r.bandPx / (W * H)).toFixed(2)}%)`)
        for (const st of r.steps) {
          console.log(`  ${String(st.from).padStart(2)} -> ${String(st.to).padStart(2)}   ${fmtResid(st.all)}   ` +
            `floor ${st.quantFloorRms.toFixed(3)} -> CORRECTED rmse ${st.allRmseCorr.toFixed(4)}` +
            (st.band ? `   band rmse ${st.band.rmse.toFixed(3)} -> CORRECTED ${st.bandRmseCorr!.toFixed(4)} (max ${st.band.max.toFixed(1)})` : ''))
        }
        console.log('  |GTn - GT64|  ' + r.vsFinest.map((v) =>
          `N${v.n}: ${v.allRmseCorr.toFixed(3)}` + (v.bandRmseCorr === null ? '' : `/band ${v.bandRmseCorr.toFixed(3)}`)).join('   '))
        console.log(`  observed order p = ${r.order === null ? 'n/a' : r.order.toFixed(2)}   ` +
          `Richardson |I64 - Iinf| rmse ~ ${r.richardsonTail === null ? 'n/a' : r.richardsonTail.toFixed(3)} codes   ` +
          `converged at N = ${r.converged.level ?? 'NOT CONVERGED at 64'}`)
      }

      // dump full frames of the finest and 1-tap for every combo
      for (const [key, byLevel] of images) {
        const safe = key.replace(/\|/g, '_')
        writePng(`frame-${safe}-N1.png`, toRgba8(byLevel.get(1)!))
        writePng(`frame-${safe}-N64.png`, toRgba8(byLevel.get(64)!))
      }
      fs.writeFileSync(path.join(OUT_DIR, 'phase14.json'), JSON.stringify(out, null, 2))
    }

    if (want('--plates')) {
      console.log('\n=== target-look plates ===')
      const plates: unknown[] = []
      for (const stim of ['hicon', 'flat'] as StimId[]) {
        const key = ladderKey('curv2p15', stim, 'nosplit')
        let byLevel = images.get(key)
        if (!byLevel) {
          byLevel = new Map<number, FloatCodes>()
          for (const N of [1, 8, 16, 32, 64]) {
            byLevel.set(N, await renderLevel(rig, stimuli[stim], USER_CFG, 'nosplit', N))
          }
        }
        const shippedKey = ladderKey('curv2p15', stim, 'shipped')
        const shipped1 = images.get(shippedKey)?.get(1)
          ?? await renderLevel(rig, stimuli[stim], USER_CFG, 'shipped', 1)

        const gt = byLevel.get(64)!
        const one = byLevel.get(1)!

        // locate the worst seam pixel, then centre a crop on it
        const f = diffField(one, gt)
        let best = -1
        let bx = 0
        let by = 0
        for (let y = MARGIN; y < H - MARGIN; y++) {
          for (let x = MARGIN; x < W - MARGIN; x++) {
            if (f[y * W + x] > best) { best = f[y * W + x]; bx = x; by = y }
          }
        }
        const CW = 40
        const CH = 72
        const x0 = Math.max(0, Math.min(W - CW, bx - Math.floor(CW / 2)))
        const y0 = Math.max(0, Math.min(H - CH, by - Math.floor(CH / 2)))
        const Z = 6
        const cropOf = (im: FloatCodes): Rgba8 => nnZoom(cropRgba(toRgba8(im), x0, y0, CW, CH), Z)

        const cols: Rgba8[] = [
          cropOf(fromRgba8(toRgba8(shipped1))),      // shipped 1-tap (working tree)
          cropOf(byLevel.get(8)!),
          cropOf(byLevel.get(16)!),
          cropOf(byLevel.get(32)!),
          cropOf(gt),
        ]
        const plate = hstack(cols, 8, [255, 0, 128])
        const name = `plate-${stim}-seam-6x.png`
        writePng(name, plate)
        console.log(`  ${name}: crop (${x0},${y0}) ${CW}x${CH} at ${Z}x, worst |1tap-GT64| = ${best.toFixed(1)} codes at (${bx},${by})`)
        console.log(`    columns: SHIPPED-1tap | GT8 | GT16 | GT32 | GT64   (magenta 8 px dividers)`)

        // CONTRAST-NORMALISED plate: a 30-code-span crop is invisible at native
        // contrast, so every column is stretched by the SAME mapping, taken from
        // the GT64 crop's p1..p99 luma. Columns stay comparable; only the
        // display gain changes.
        {
          const gtCrop = cropRgba(toRgba8(gt), x0, y0, CW, CH)
          const lv: number[] = []
          const gcf = fromRgba8(gtCrop)
          for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) lv.push(luma(gcf, x, y))
          lv.sort((a, b) => a - b)
          const lo = lv[Math.floor(lv.length * 0.01)]
          const hi = lv[Math.floor(lv.length * 0.99)]
          const nrm = (im: FloatCodes): Rgba8 => nnZoom(normaliseTo(cropRgba(toRgba8(im), x0, y0, CW, CH), lo, hi), Z)
          const nplate = hstack([
            nrm(fromRgba8(toRgba8(shipped1))), nrm(byLevel.get(8)!), nrm(byLevel.get(16)!),
            nrm(byLevel.get(32)!), nrm(gt),
          ], 8, [255, 0, 128])
          writePng(`plate-${stim}-seam-6x-norm.png`, nplate)
          console.log(`  plate-${stim}-seam-6x-norm.png: same crop, luma ${lo.toFixed(1)}..${hi.toFixed(1)} codes stretched to 0..255 (gain ${(255 / (hi - lo)).toFixed(1)}x)`)
        }

        // SEAM TRACK: does the contour staircase, and does the caustic survive?
        // Window is one rib period wide about the worst pixel, 200 rows tall.
        const tw0 = Math.max(1, Math.min(W - 62, bx - 30))
        const ty0 = Math.max(MARGIN, Math.min(H - 200 - MARGIN, by - 100))
        const tracks: Record<string, SeamTrack> = {}
        tracks.SHIPPED1 = seamTrack(shipped1, tw0, tw0 + 60, ty0, ty0 + 200)
        for (const N of [1, 8, 16, 32, 64]) {
          const im = byLevel.get(N)
          if (im) tracks[`GT${N}`] = seamTrack(im, tw0, tw0 + 60, ty0, ty0 + 200)
        }
        console.log(`  seam track, window x ${tw0}..${tw0 + 60} y ${ty0}..${ty0 + 200}:`)
        for (const [k, t] of Object.entries(tracks)) {
          const pk = t.peakCodes.reduce((a, b) => a + b, 0) / t.peakCodes.length
          console.log(`    ${k.padEnd(9)} jumpMax ${t.jumpMax.toFixed(2)} px  jumpP95 ${t.jumpP95.toFixed(2)} px  ` +
            `flatRun p50 ${t.flatRunP50} max ${t.flatRunMax} rows  |2nd diff| ${t.curvature2nd.toFixed(3)} px  ` +
            `mean peak gradient ${pk.toFixed(2)} codes/px`)
        }

        // scanline through the worst row: luma across the seam, every level, and
        // a plot so the shape can be read back as an image rather than as digits
        const rowY = by
        const scan: Record<string, number[]> = {}
        const xs: number[] = []
        for (let x = 0; x < W; x++) xs.push(x)
        const sh1 = fromRgba8(toRgba8(shipped1))
        scan.SHIPPED1 = xs.map((x) => +luma(sh1, x, rowY).toFixed(2))
        for (const N of [1, 8, 16, 32, 64]) {
          const im = byLevel.get(N)
          if (im) scan[`GT${N}`] = xs.map((x) => +luma(im, x, rowY).toFixed(2))
        }
        writePng(`profile-${stim}-row${rowY}.png`, profilePlot([
          { label: 'SHIPPED1', vals: scan.SHIPPED1, rgb: [255, 90, 90] },
          { label: 'GT64', vals: scan.GT64, rgb: [110, 235, 130] },
        ], 220))
        {
          const sMin = Math.min(...scan.SHIPPED1)
          const sMax = Math.max(...scan.SHIPPED1)
          const gMin = Math.min(...scan.GT64)
          const gMax = Math.max(...scan.GT64)
          // per-pixel seam contrast along the row: the quantity a metric must resolve
          let mxg = 0
          for (let x = 1; x < W - 1; x++) mxg = Math.max(mxg, Math.abs(scan.GT64[x + 1] - scan.GT64[x - 1]) * 0.5)
          console.log(`  row ${rowY} luma: SHIPPED1 ${sMin.toFixed(1)}..${sMax.toFixed(1)} (span ${(sMax - sMin).toFixed(1)})  ` +
            `GT64 ${gMin.toFixed(1)}..${gMax.toFixed(1)} (span ${(gMax - gMin).toFixed(1)})  ` +
            `max GT64 gradient ${mxg.toFixed(2)} codes/px`)
        }

        plates.push({
          stimulus: stim, crop: { x0, y0, w: CW, h: CH, zoom: Z },
          worst: { codes: best, x: bx, y: by },
          scanlineY: rowY, scanlineX: xs, scan, tracks,
          trackWindow: { x0: tw0, x1: tw0 + 60, y0: ty0, y1: ty0 + 200 },
          spans: {
            SHIPPED1: lumaSpan(shipped1), GT1: lumaSpan(one),
            GT8: byLevel.get(8) ? lumaSpan(byLevel.get(8)!) : null,
            GT16: byLevel.get(16) ? lumaSpan(byLevel.get(16)!) : null,
            GT32: byLevel.get(32) ? lumaSpan(byLevel.get(32)!) : null,
            GT64: lumaSpan(gt),
          },
        })

        // full-frame side by side, unzoomed, for the macroscopic look question
        writePng(`full-${stim}-SHIPPED1.png`, toRgba8(shipped1))
        writePng(`full-${stim}-GT64.png`, toRgba8(gt))
      }
      out.plates = plates
      fs.writeFileSync(path.join(OUT_DIR, 'phase14.json'), JSON.stringify(out, null, 2))
    }

    fs.writeFileSync(path.join(OUT_DIR, 'phase14.json'), JSON.stringify(out, null, 2))
    console.log(`\nwrote ${path.join(OUT_DIR, 'phase14.json')}`)
  } finally {
    await rig.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
