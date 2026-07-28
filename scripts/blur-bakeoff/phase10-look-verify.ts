/**
 * Phase 10c — ADVERSARIAL LOOK VERIFICATION of the phase-10b winner (A3, RGSS 4-rook).
 *
 * The phase-10b sweep proves A3 wins on numbers. Numbers are not the complaint.
 * This script attacks the LOOK claim:
 *
 *   1. The sweep's proof PNGs are 48x48 device-px crops at the FRAME CENTRE,
 *      upscaled 4x. On the photo stimulus the frame centre is a smooth cyan
 *      feather field. This script instead SEARCHES for the crop window that
 *      maximises (local contrast x seam presence) and crops 160x160 there, so
 *      the seam is shown where it actually reads.
 *   2. Amplified residual maps |cand - GT| x gain, full frame, so residual
 *      STRUCTURE (staircase / caustic line / fold crease) is visible rather
 *      than summarised into one mean.
 *   3. Look-specific numeric probes the sweep never ran:
 *        - overshoot / ringing (values outside the local GT envelope)
 *        - smear: gradient energy in the seam band vs GT (under = over-blurred)
 *        - far-field sharpness: gradient energy outside the seam band vs GT
 *        - caustic hardness: peak |2nd difference| across the caustic ring
 *        - residual periodicity along the seam (a staircase is periodic;
 *          sampling noise is not)
 *
 * Read-only w.r.t. src/. Writes only reports/blur-bakeoff/phase10/look/.
 *
 * Run:  npx tsx scripts/blur-bakeoff/phase10-look-verify.ts
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  buildGraph, candidatePasses, seamProbePasses, CANDIDATE_BY_ID, CONFIGS,
  type BenchConfig, type ReedCfg, type StimulusId,
} from './phase10-reed-aa.ts'
import { createAaRig, type AaRig, type Backend } from './phase10-aa-rig.ts'
import type { Rgba8 } from './lib/image.ts'
import { encodePng } from './lib/png.ts'
import {
  decodeSeamField, seamBand, lumaField, maskedDiff, type SeamField,
} from './lib/edge-metrics.ts'

const REPO = process.cwd()
const OUT = path.join(REPO, 'reports', 'blur-bakeoff', 'phase10', 'look')
const SEAM_RANGE_PX = 8
const SEAM_BAND_PX = 3
const MASK_MARGIN = 12

const W = 1200
const H = 800

// ---------------------------------------------------------------------------
// Stimuli — copied verbatim from phase10-reed-aa.ts so the pixels are identical
// ---------------------------------------------------------------------------

function ramp(w: number, h: number): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = Math.round((x / (w - 1)) * 255)
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

function hfNoise(w: number, h: number, seed = 1): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  let s = seed >>> 0
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const v = Math.round(rnd() * 255)
    d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
  }
  return { width: w, height: h, data: d }
}

function thinLines(w: number, h: number, spacing = 9): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const on = x % spacing === 0 || y % spacing === 4
      const v = on ? 245 : 10
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

function coverCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const s = Math.max(w / img.width, h / img.height)
  const sw = Math.max(1, Math.round(img.width * s))
  const sh = Math.max(1, Math.round(img.height * s))
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

function stepImg(w: number, h: number): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const v = x < w / 2 ? 25 : 230
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

async function loadStimuli(rig: AaRig): Promise<Map<StimulusId, Rgba8>> {
  const m = new Map<StimulusId, Rgba8>()
  const bytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'stuff', '5468102179_8f885a1744_o.jpg')))
  const photo = coverCrop(await rig.decodeImage(bytes, 'image/jpeg', 2048), W, H)
  m.set('photo', photo)
  m.set('noise', hfNoise(W, H))
  m.set('lines', thinLines(W, H))
  m.set('ramp-x', ramp(W, H))
  m.set('step', stepImg(W, H))
  return m
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function crop(img: Rgba8, x0: number, y0: number, w: number, h: number): Rgba8 {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(img.height - 1, y0 + y))
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(img.width - 1, x0 + x))
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out }
}

function upscaleNearest(img: Rgba8, k: number): Rgba8 {
  const w = img.width * k
  const h = img.height * k
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4
      out.set(img.data.subarray(s, s + 4), (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out }
}

function boxDown(img: Rgba8, s: number): Rgba8 {
  const w = Math.floor(img.width / s)
  const h = Math.floor(img.height / s)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0]
      for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
          const o = ((y * s + j) * img.width + (x * s + i)) * 4
          for (let c = 0; c < 4; c++) acc[c] += img.data[o + c]
        }
      }
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / (s * s))
    }
  }
  return { width: w, height: h, data: out }
}

function hstack(imgs: Rgba8[], gap = 6): Rgba8 {
  const h = Math.max(...imgs.map((i) => i.height))
  const w = imgs.reduce((a, i) => a + i.width, 0) + gap * (imgs.length - 1)
  const out = new Uint8ClampedArray(w * h * 4).fill(0)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  let x0 = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        out.set(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4), (y * w + x0 + x) * 4)
      }
    }
    x0 += im.width
    if (x0 < w) {
      for (let y = 0; y < h; y++) {
        for (let g = 0; g < gap; g++) {
          const o = (y * w + x0 + g) * 4
          out[o] = 255; out[o + 1] = 0; out[o + 2] = 128; out[o + 3] = 255
        }
      }
      x0 += gap
    }
  }
  return { width: w, height: h, data: out }
}

function vstack(imgs: Rgba8[], gap = 6): Rgba8 {
  const w = Math.max(...imgs.map((i) => i.width))
  const h = imgs.reduce((a, i) => a + i.height, 0) + gap * (imgs.length - 1)
  const out = new Uint8ClampedArray(w * h * 4).fill(0)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  let y0 = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      out.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), ((y0 + y) * w) * 4)
    }
    y0 += im.height + gap
  }
  return { width: w, height: h, data: out }
}

/** |a-b| per channel, x gain, grey-mapped on max channel. */
function diffMap(a: Rgba8, b: Rgba8, gain: number): Rgba8 {
  const out = new Uint8ClampedArray(a.width * a.height * 4)
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4
    const d = Math.max(
      Math.abs(a.data[o] - b.data[o]),
      Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2]),
    )
    const v = Math.min(255, Math.round(d * gain))
    out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255
  }
  return { width: a.width, height: a.height, data: out }
}

function writePng(name: string, img: Rgba8): string {
  fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, name)
  fs.writeFileSync(p, encodePng(img))
  return p
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function periodPx(cfg: ReedCfg, dpr: number): number {
  return (cfg.ribWidth ?? 80) * dpr * (cfg.srt_scale ?? 1)
}

async function render(
  rig: AaRig, stim: Rgba8, bc: BenchConfig, candId: string, backend: Backend,
): Promise<Rgba8> {
  const cand = CANDIDATE_BY_ID[candId]
  const k = cand.renderScale ?? 1
  const cfg: ReedCfg = candId.startsWith('A9') ? { ...bc.cfg, frost: 0 } : bc.cfg
  const g = buildGraph(cfg, W / H)
  const ctx = { frostRadiusPx: (bc.cfg.frost ?? 0) * 24 * bc.dpr, periodPx: periodPx(bc.cfg, bc.dpr) }
  const passes = candidatePasses(g, cand, W * k, H * k, ctx, 'color')
  const r = await rig.run({
    backend, width: W * k, height: H * k, dpr: bc.dpr * k,
    passes, images: { [g.imageSampler]: stim },
  })
  return k === 1 ? r.image : boxDown(r.image, k)
}

async function seamFieldOf(rig: AaRig, stim: Rgba8, bc: BenchConfig, backend: Backend): Promise<SeamField> {
  const g = buildGraph(bc.cfg, W / H)
  const r = await rig.run({
    backend, width: W, height: H, dpr: bc.dpr,
    passes: seamProbePasses(g, W, H, SEAM_RANGE_PX), images: { [g.imageSampler]: stim },
  })
  return decodeSeamField(r.image, SEAM_RANGE_PX)
}

// ---------------------------------------------------------------------------
// Crop selection — find the window where a seam crosses the MOST contrast
// ---------------------------------------------------------------------------

interface Window { x: number; y: number; score: number; seamFrac: number; contrast: number }

function pickWindow(gt: Rgba8, band: Uint8Array, size: number): Window {
  const L = lumaField(gt)
  const step = 20
  let best: Window = { x: 0, y: 0, score: -1, seamFrac: 0, contrast: 0 }
  for (let y = MASK_MARGIN; y + size < H - MASK_MARGIN; y += step) {
    for (let x = MASK_MARGIN; x + size < W - MASK_MARGIN; x += step) {
      let seam = 0
      let sum = 0
      let sum2 = 0
      let n = 0
      // local contrast measured ON the seam pixels only: a window whose seam
      // runs through flat sky scores 0 no matter how busy its corners are.
      for (let j = 0; j < size; j += 2) {
        for (let i = 0; i < size; i += 2) {
          const idx = (y + j) * W + (x + i)
          if (!band[idx]) continue
          seam++
          const v = L[idx]
          sum += v; sum2 += v * v; n++
        }
      }
      if (n < 40) continue
      const varr = Math.max(0, sum2 / n - (sum / n) ** 2)
      const contrast = Math.sqrt(varr)
      const seamFrac = seam / ((size / 2) ** 2)
      const score = contrast * Math.min(seamFrac / 0.06, 1)
      if (score > best.score) best = { x, y, score, seamFrac, contrast }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Look probes
// ---------------------------------------------------------------------------

/** Fraction of pixels whose value escapes the 3x3 GT envelope by > tol codes. */
function overshoot(cand: Rgba8, gt: Rgba8, mask: Uint8Array, tol: number): { frac: number; worst: number } {
  let n = 0
  let hit = 0
  let worst = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (!mask[i]) continue
      n++
      let over = 0
      for (let c = 0; c < 3; c++) {
        let lo = 255
        let hi = 0
        for (let j = -1; j <= 1; j++) {
          for (let k = -1; k <= 1; k++) {
            const v = gt.data[((y + j) * W + x + k) * 4 + c]
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
        }
        const v = cand.data[i * 4 + c]
        over = Math.max(over, v > hi ? v - hi : lo - v)
      }
      if (over > tol) hit++
      if (over > worst) worst = over
    }
  }
  return { frac: n ? hit / n : 0, worst }
}

/** Mean |gradient| of luma over a mask. Under GT = softer, over GT = aliased-hard. */
function gradEnergy(img: Rgba8, mask: Uint8Array): number {
  const L = lumaField(img)
  let s = 0
  let n = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      if (!mask[i]) continue
      const gx = L[i + 1] - L[i - 1]
      const gy = L[i + W] - L[i - W]
      s += Math.hypot(gx, gy); n++
    }
  }
  return n ? s / n : 0
}

function complement(band: Uint8Array, dilate: number, f: SeamField): Uint8Array {
  const out = new Uint8Array(W * H)
  for (let y = MASK_MARGIN; y < H - MASK_MARGIN; y++) {
    for (let x = MASK_MARGIN; x < W - MASK_MARGIN; x++) {
      const i = y * W + x
      if (Math.abs(f.dist[i]) > SEAM_BAND_PX + dilate) out[i] = 1
    }
  }
  void band
  return out
}

/**
 * Residual periodicity along the seam. A staircase repeats with the period of
 * the rasterised edge; sampling noise does not. Returns the strongest
 * normalised autocorrelation of the seam-band residual at lags 2..40 px,
 * measured ALONG the seam.
 */
function residualPeriodicity(cand: Rgba8, gt: Rgba8, f: SeamField, band: Uint8Array): { peak: number; lag: number } {
  // scan along y (seams are mostly vertical-ish in this matrix); project the
  // residual of each row of the band into a 1-D signal
  const sig: number[] = []
  for (let y = MASK_MARGIN; y < H - MASK_MARGIN; y++) {
    let s = 0
    let n = 0
    for (let x = MASK_MARGIN; x < W - MASK_MARGIN; x++) {
      const i = y * W + x
      if (!band[i]) continue
      const o = i * 4
      const d = Math.max(
        Math.abs(cand.data[o] - gt.data[o]),
        Math.abs(cand.data[o + 1] - gt.data[o + 1]),
        Math.abs(cand.data[o + 2] - gt.data[o + 2]),
      )
      // sign it by which side of the seam we are on, so a coverage error that
      // alternates sides shows up as an oscillation rather than a DC term
      s += d * Math.sign(f.dist[i] || 1); n++
    }
    sig.push(n ? s / n : 0)
  }
  const m = sig.reduce((a, b) => a + b, 0) / sig.length
  const c = sig.map((v) => v - m)
  const c0 = c.reduce((a, b) => a + b * b, 0)
  let peak = 0
  let lag = 0
  for (let L2 = 2; L2 <= 40; L2++) {
    let s = 0
    for (let i = 0; i + L2 < c.length; i++) s += c[i] * c[i + L2]
    const r = c0 > 1e-9 ? s / c0 : 0
    if (r > peak) { peak = r; lag = L2 }
  }
  return { peak, lag }
}

// ---------------------------------------------------------------------------

interface LookRow {
  config: string
  candidate: string
  seamGrad: number
  farGrad: number
  overshootFrac: number
  overshootWorst: number
  periodPeak: number
  periodLag: number
  seamMean: number
  seamP95: number
  seamMax: number
}

const LOOK_CONFIGS = [
  'default', 'misaligned', 'curv1p5', 'ior2p5', 'rot15', 'rot45',
  'wave-sine', 'bow0', 'rib20', 'noise', 'lines', 'frost0p3',
  'stair-rot7', 'stair-rot45',
]

const LOOK_CANDS = ['A0', 'A4', 'A3', 'A8']

async function main(): Promise<void> {
  const rig = await createAaRig()
  const backend: Backend = rig.available.webgpu ? 'webgpu' : 'webgl2'
  const rows: LookRow[] = []
  const windows: Record<string, Window> = {}
  try {
    const stimuli = await loadStimuli(rig)
    for (const id of LOOK_CONFIGS) {
      const bc = CONFIGS.find((c) => c.id === id)
      if (!bc) throw new Error(`no config ${id}`)
      const stim = stimuli.get(bc.stimulus)!
      const f = await seamFieldOf(rig, stim, bc, backend)
      const band = seamBand(f, SEAM_BAND_PX, MASK_MARGIN)
      const far = complement(band, 3, f)
      const imgs: Record<string, Rgba8> = {}
      for (const cid of LOOK_CANDS) imgs[cid] = await render(rig, stim, bc, cid, backend)
      const gt = imgs['A8']

      const win = pickWindow(gt, band, 160)
      windows[id] = win

      for (const cid of LOOK_CANDS) {
        const im = imgs[cid]
        const d = maskedDiff(im, gt, band)
        const os = overshoot(im, gt, band, 1)
        const per = residualPeriodicity(im, gt, f, band)
        rows.push({
          config: id, candidate: cid,
          seamGrad: gradEnergy(im, band), farGrad: gradEnergy(im, far),
          overshootFrac: os.frac, overshootWorst: os.worst,
          periodPeak: per.peak, periodLag: per.lag,
          seamMean: d.mean, seamP95: d.p95, seamMax: d.max,
        })
      }

      // 4-panel high-contrast seam crop, 3x
      const strip = (im: Rgba8): Rgba8 => upscaleNearest(crop(im, win.x, win.y, 160, 160), 3)
      writePng(`look-${id}.png`, hstack(LOOK_CANDS.map((k) => strip(imgs[k]))))
      // residual structure, full frame, 2x down, gain 8
      writePng(`resid-${id}.png`, vstack([
        boxDown(diffMap(imgs['A0'], gt, 8), 2),
        boxDown(diffMap(imgs['A3'], gt, 8), 2),
      ]))
      // residual, same crop, gain 8, 3x — A0 | A4 | A3
      writePng(`residcrop-${id}.png`, hstack(['A0', 'A4', 'A3'].map(
        (k) => upscaleNearest(crop(diffMap(imgs[k], gt, 8), win.x, win.y, 160, 160), 3))))

      const r0 = rows.find((r) => r.config === id && r.candidate === 'A0')!
      const r3 = rows.find((r) => r.config === id && r.candidate === 'A3')!
      const r8 = rows.find((r) => r.config === id && r.candidate === 'A8')!
      console.log(
        `${id}: win(${win.x},${win.y}) contrast=${win.contrast.toFixed(1)} | ` +
        `seamGrad A0=${r0.seamGrad.toFixed(2)} A3=${r3.seamGrad.toFixed(2)} GT=${r8.seamGrad.toFixed(2)} | ` +
        `far A0=${r0.farGrad.toFixed(2)} A3=${r3.farGrad.toFixed(2)} GT=${r8.farGrad.toFixed(2)} | ` +
        `over A3=${(r3.overshootFrac * 100).toFixed(2)}%/${r3.overshootWorst} | ` +
        `per A0=${r0.periodPeak.toFixed(2)}@${r0.periodLag} A3=${r3.periodPeak.toFixed(2)}@${r3.periodLag}`)
    }
  } finally {
    await rig.close()
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'look-verify.json'),
    JSON.stringify({ generated: new Date().toISOString(), width: W, height: H, windows, rows }, null, 2))
  console.log(`\nwrote ${path.join(OUT, 'look-verify.json')} (${rows.length} rows)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
