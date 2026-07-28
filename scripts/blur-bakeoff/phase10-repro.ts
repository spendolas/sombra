/**
 * Phase 10 — reproduce the "rough antialiasing on the rib edges" artefact of the
 * Reeded Glass node headlessly, on WebGPU, at 1200x800, running the node's OWN
 * emitted WGSL (see phase10-graph.ts / phase10-rig.ts — nothing is reimplemented).
 *
 * The central discriminator is 16x16 supersampling of the SAME shader:
 *   - an artefact that supersampling REMOVES is intra-pixel aliasing
 *     (staircase / shimmer) and is fixable by taking more samples;
 *   - an artefact supersampling leaves untouched is a genuine C0 step in the
 *     output image (a hard cut) and more samples will never help.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase10-repro.ts [--quick]
 */

import fs from 'node:fs'
import path from 'node:path'
import { createPhase10Rig, type Phase10Rig } from './phase10-rig'
import { buildReededGraph, IMAGE_SAMPLER, type ReededConfig } from './phase10-graph'
import type { Rgba8 } from './lib/image'
import { encodePng } from './lib/png'

const W = 1200, H = 800
const OUT = path.join('reports', 'blur-bakeoff', 'phase10', 'repro')
const QUICK = process.argv.includes('--quick')
const SSAA = QUICK ? 8 : 16

// ---------------------------------------------------------------------------
// image helpers
// ---------------------------------------------------------------------------

function blank(w: number, h: number): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 3; i < d.length; i += 4) d[i] = 255
  return { width: w, height: h, data: d }
}

function luma(img: Rgba8, x: number, y: number): number {
  const i = (y * img.width + x) * 4
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
}

/** Separable Gaussian on 8-bit values (sRGB space — we only need band-limiting). */
function blur(img: Rgba8, sigma: number): Rgba8 {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float64Array(2 * r + 1)
  let s = 0
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r] }
  for (let i = 0; i < k.length; i++) k[i] /= s
  const tmp = new Float64Array(img.width * img.height * 4)
  const out = blank(img.width, img.height)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      for (let c = 0; c < 3; c++) {
        let a = 0
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(img.width - 1, Math.max(0, x + i))
          a += img.data[(y * img.width + xx) * 4 + c] * k[i + r]
        }
        tmp[(y * img.width + x) * 4 + c] = a
      }
    }
  }
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      for (let c = 0; c < 3; c++) {
        let a = 0
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(img.height - 1, Math.max(0, y + i))
          a += tmp[(yy * img.width + x) * 4 + c] * k[i + r]
        }
        out.data[(y * img.width + x) * 4 + c] = Math.round(a)
      }
    }
  }
  return out
}

/** Cover-fit + centre-crop an arbitrary image to w x h (box filter). */
function coverCrop(src: Rgba8, w: number, h: number): Rgba8 {
  const scale = Math.max(w / src.width, h / src.height)
  const sw = Math.round(src.width * scale), sh = Math.round(src.height * scale)
  const out = blank(w, h)
  const ox = Math.floor((sw - w) / 2), oy = Math.floor((sh - h) / 2)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx0 = (x + ox) / scale, fx1 = (x + ox + 1) / scale
      const fy0 = (y + oy) / scale, fy1 = (y + oy + 1) / scale
      const x0 = Math.max(0, Math.floor(fx0)), x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil(fx1)))
      const y0 = Math.max(0, Math.floor(fy0)), y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil(fy1)))
      const acc = [0, 0, 0]; let n = 0
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * src.width + sx) * 4
        acc[0] += src.data[i]; acc[1] += src.data[i + 1]; acc[2] += src.data[i + 2]; n++
      }
      const o = (y * w + x) * 4
      out.data[o] = acc[0] / n; out.data[o + 1] = acc[1] / n; out.data[o + 2] = acc[2] / n
    }
  }
  return out
}

/** Analytically anti-aliased oblique black/white edge (16x16 coverage). */
function aaDiagonal(w: number, h: number, deg: number): Rgba8 {
  const out = blank(w, h)
  const th = (deg * Math.PI) / 180
  const nx = Math.cos(th), ny = Math.sin(th)
  const cx = w / 2, cy = h / 2
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let cov = 0
    for (let sy = 0; sy < 16; sy++) for (let sx = 0; sx < 16; sx++) {
      const px = x + (sx + 0.5) / 16, py = y + (sy + 0.5) / 16
      if ((px - cx) * nx + (py - cy) * ny > 0) cov++
    }
    const v = Math.round((cov / 256) * 235 + 10)
    const i = (y * w + x) * 4
    out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v
  }
  return out
}

/** KNOWN-BAD calibration image: a 1-px hard cut of `amp` luma levels every 80 px. */
function hardCutField(w: number, h: number, amp: number, period: number): Rgba8 {
  const out = blank(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const base = 120 + Math.round((x / w) * 20)
    const v = base + (Math.floor(x / period) % 2 === 0 ? 0 : amp)
    const i = (y * w + x) * 4
    out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v
  }
  return out
}

function crop(img: Rgba8, x0: number, y0: number, w: number, h: number, zoom: number): Rgba8 {
  const out = blank(w * zoom, h * zoom)
  for (let y = 0; y < h * zoom; y++) for (let x = 0; x < w * zoom; x++) {
    const sx = Math.min(img.width - 1, x0 + Math.floor(x / zoom))
    const sy = Math.min(img.height - 1, y0 + Math.floor(y / zoom))
    const s = (sy * img.width + sx) * 4, o = (y * out.width + x) * 4
    out.data[o] = img.data[s]; out.data[o + 1] = img.data[s + 1]
    out.data[o + 2] = img.data[s + 2]; out.data[o + 3] = img.data[s + 3]
  }
  return out
}

/** Side-by-side [a | gap | b]. */
function sideBySide(a: Rgba8, b: Rgba8, gap = 8): Rgba8 {
  const out = blank(a.width + gap + b.width, Math.max(a.height, b.height))
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 128 }
  const put = (im: Rgba8, ox: number) => {
    for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
      const s = (y * im.width + x) * 4, o = (y * out.width + x + ox) * 4
      out.data[o] = im.data[s]; out.data[o + 1] = im.data[s + 1]
      out.data[o + 2] = im.data[s + 2]; out.data[o + 3] = 255
    }
  }
  put(a, 0); put(b, a.width + gap)
  return out
}

function bilinearResize(img: Rgba8, w: number, h: number): Rgba8 {
  const out = blank(w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = ((x + 0.5) * img.width) / w - 0.5
    const fy = ((y + 0.5) * img.height) / h - 0.5
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const tx = fx - x0, ty = fy - y0
    const gx = (v: number) => Math.min(img.width - 1, Math.max(0, v))
    const gy = (v: number) => Math.min(img.height - 1, Math.max(0, v))
    const o = (y * w + x) * 4
    for (let c = 0; c < 3; c++) {
      const p = (xx: number, yy: number) => img.data[(gy(yy) * img.width + gx(xx)) * 4 + c]
      out.data[o + c] =
        p(x0, y0) * (1 - tx) * (1 - ty) + p(x0 + 1, y0) * tx * (1 - ty) +
        p(x0, y0 + 1) * (1 - tx) * ty + p(x0 + 1, y0 + 1) * tx * ty
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/**
 * Discontinuity field: the larger of the horizontal and vertical adjacent-pixel
 * luma jumps, in 0..255 levels. On a band-limited source with no hard edges any
 * large value in the OUTPUT is an artefact of the map.
 */
function discontinuity(img: Rgba8): { p999: number; p9999: number; max: number; field: Float32Array } {
  const f = new Float32Array(img.width * img.height)
  for (let y = 1; y < img.height; y++) for (let x = 1; x < img.width; x++) {
    const c = luma(img, x, y)
    f[y * img.width + x] = Math.max(Math.abs(c - luma(img, x - 1, y)), Math.abs(c - luma(img, x, y - 1)))
  }
  const sorted = Float32Array.from(f).sort()
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return { p999: q(0.999), p9999: q(0.9999), max: sorted[sorted.length - 1], field: f }
}

function rms(a: Rgba8, b: Rgba8): { rms: number; max: number } {
  let s = 0, m = 0, n = 0
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 === 3) continue
    const d = a.data[i] - b.data[i]
    s += d * d; n++
    if (Math.abs(d) > m) m = Math.abs(d)
  }
  return { rms: Math.sqrt(s / n), max: m }
}

/**
 * How much of the discontinuity structure sits on long straight vertical runs
 * (a hard cut) versus short broken runs (a staircase) versus isolated pixels
 * (shimmer). Operates on the top-N discontinuity pixels.
 */
function runStructure(field: Float32Array, w: number, h: number, thresh: number): {
  count: number; longRunFrac: number; isolatedFrac: number; axis: 'v' | 'h' | '-'; energy: number
} {
  const hot = new Uint8Array(w * h)
  let count = 0, energy = 0
  for (let i = 0; i < field.length; i++) if (field[i] >= thresh) { hot[i] = 1; count++; energy += field[i] }
  if (count === 0) return { count: 0, longRunFrac: 0, isolatedFrac: 0, axis: '-', energy: 0 }

  // Scan BOTH axes — horizontal ribs make horizontal seams, and a vertical-only
  // scan reports them as "isolated pixels", which reads as shimmer when it is a
  // hard cut lying the other way.
  const scan = (outer: number, inner: number, idx: (a: number, b: number) => number) => {
    let longPix = 0, iso = 0
    for (let a = 0; a < outer; a++) {
      let run = 0
      for (let b = 0; b <= inner; b++) {
        const on = b < inner && hot[idx(a, b)] === 1
        if (on) run++
        else if (run > 0) { if (run >= 20) longPix += run; if (run <= 2) iso += run; run = 0 }
      }
    }
    return { longPix, iso }
  }
  const v = scan(w, h, (x, y) => y * w + x)
  const h_ = scan(h, w, (y, x) => y * w + x)
  const useV = v.longPix >= h_.longPix
  const best = useV ? v : h_
  return {
    count, energy,
    longRunFrac: best.longPix / count,
    isolatedFrac: Math.min(v.iso, h_.iso) / count,
    axis: best.longPix === 0 ? '-' : (useV ? 'v' : 'h'),
  }
}

// ---------------------------------------------------------------------------
// analytic check of the map (no GPU) — d(sampled coord)/d(screen coord)
// ---------------------------------------------------------------------------

function lensLocal(local: number, ior: number, curvature: number): number {
  const x = (local - 0.5) * 2
  const c = Math.min(1, Math.max(0.01, curvature))
  const amp = curvature > 1 ? curvature : 1
  const c2 = Math.min(c, 0.99)
  const x2 = x * x * c2 * c2
  const slope = (x * c2) / Math.sqrt(Math.max(1 - x2, 0.001))
  const disp = -slope * (ior - 1) * 0.5 * amp
  const lensed = local + disp
  return 1 - Math.abs(((lensed * 0.5) - Math.floor(lensed * 0.5)) * 2 - 1)
}

function derivativeProfile(ior: number, curvature: number): {
  atCentre: number; atEdge: number; zeroCrossings: number; seamJumpRibs: number; minAbs: number; maxAbs: number
} {
  const N = 20001
  const vals: number[] = []
  for (let i = 0; i < N; i++) vals.push(lensLocal(i / (N - 1), ior, curvature))
  const d: number[] = []
  for (let i = 1; i < N; i++) d.push((vals[i] - vals[i - 1]) * (N - 1))
  let zc = 0
  for (let i = 1; i < d.length; i++) if (d[i - 1] * d[i] < 0) zc++
  const left = vals[N - 1]          // lensed as local -> 1
  const right = vals[0]             // lensed as local -> 0 in the NEXT rib
  return {
    atCentre: d[Math.floor(d.length / 2)],
    atEdge: d[d.length - 1],
    zeroCrossings: zc,
    seamJumpRibs: 1 + right - left,
    minAbs: Math.min(...d.map(Math.abs)),
    maxAbs: Math.max(...d.map(Math.abs)),
  }
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

interface Case { name: string; cfg: ReededConfig; dpr?: number; note?: string }

const BASE: ReededConfig = { ribWidth: 80, ior: 1.5, curvature: 0.8, bow: 1, frost: 0, direction: 'vertical', ribType: 'straight' }

const CASES: Case[] = [
  { name: 'A00-identity-ior1', cfg: { ...BASE, ior: 1.0 }, note: 'control: no refraction' },
  { name: 'A01-default', cfg: { ...BASE } },
  { name: 'A02-default-halfpx-phase', cfg: { ...BASE, srt_translateX: 0.5 }, note: 'seams shifted off the pixel grid' },
  { name: 'B01-rib160', cfg: { ...BASE, ribWidth: 160 } },
  { name: 'B02-rib40', cfg: { ...BASE, ribWidth: 40 } },
  { name: 'B03-rib20', cfg: { ...BASE, ribWidth: 20 } },
  { name: 'B04-rib8', cfg: { ...BASE, ribWidth: 8 } },
  { name: 'B05-rib4', cfg: { ...BASE, ribWidth: 4 } },
  { name: 'B06-rib37', cfg: { ...BASE, ribWidth: 37 }, note: 'non-pixel-aligned period' },
  { name: 'C01-rot7', cfg: { ...BASE, srt_rotate: 7 } },
  { name: 'C02-rot23', cfg: { ...BASE, srt_rotate: 23 } },
  { name: 'C03-rot45', cfg: { ...BASE, srt_rotate: 45 } },
  { name: 'C04-rot23-rib20', cfg: { ...BASE, srt_rotate: 23, ribWidth: 20 } },
  { name: 'D01-bow0', cfg: { ...BASE, bow: 0 } },
  { name: 'D02-bow-neg1', cfg: { ...BASE, bow: -1 } },
  { name: 'E01-ior3', cfg: { ...BASE, ior: 3.0 } },
  { name: 'E02-ior1p1', cfg: { ...BASE, ior: 1.1 } },
  { name: 'E03-curv0p05', cfg: { ...BASE, curvature: 0.05 } },
  { name: 'E04-curv2', cfg: { ...BASE, curvature: 2.0 } },
  { name: 'F01-wave-sine', cfg: { ...BASE, ribType: 'wave', waveShape: 'sine', amplitude: 20, wavelength: 200 } },
  { name: 'F02-wave-triangle', cfg: { ...BASE, ribType: 'wave', waveShape: 'triangle', amplitude: 20, wavelength: 200 } },
  { name: 'F03-wave-square', cfg: { ...BASE, ribType: 'wave', waveShape: 'square', amplitude: 20, wavelength: 200 } },
  { name: 'F04-wave-sawtooth', cfg: { ...BASE, ribType: 'wave', waveShape: 'sawtooth', amplitude: 20, wavelength: 200 } },
  { name: 'F05-wave-chevron', cfg: { ...BASE, ribType: 'wave', waveShape: 'chevron', amplitude: 20, wavelength: 200 } },
  { name: 'F06-wave-ushape', cfg: { ...BASE, ribType: 'wave', waveShape: 'u_shape', amplitude: 20, wavelength: 200 } },
  { name: 'G01-circular', cfg: { ...BASE, ribType: 'circular', amplitude: 20, wavelength: 200 } },
  { name: 'G02-noise-simplex', cfg: { ...BASE, ribType: 'noise', noiseType: 'simplex', amplitude: 20, wavelength: 200 } },
  { name: 'H01-horizontal', cfg: { ...BASE, direction: 'horizontal' } },
  { name: 'I01-frost0p3', cfg: { ...BASE, frost: 0.3 } },
  { name: 'I02-frost1p0', cfg: { ...BASE, frost: 1.0 }, note: 'max scatter — does 8-tap frost hide the cut?' },
  { name: 'J01-dpr2', cfg: { ...BASE }, dpr: 2, note: '600x400 CSS at DPR 2' },
]

// ---------------------------------------------------------------------------

function save(name: string, img: Rgba8): string {
  fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, `${name}.png`)
  fs.writeFileSync(p, encodePng(img))
  return p
}

async function render(rig: Phase10Rig, cfg: ReededConfig, stim: Rgba8, opts: { dpr?: number; ssaa?: number; w?: number; h?: number } = {}): Promise<Rgba8> {
  const w = opts.w ?? W, h = opts.h ?? H
  const g = buildReededGraph(cfg, W / H)
  if (opts.ssaa && opts.ssaa > 1) g.passes[g.passes.length - 1].ssaa = opts.ssaa
  return rig.run({ width: w, height: h, dpr: opts.dpr ?? 1, passes: g.passes, images: { [IMAGE_SAMPLER]: stim } })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const rig = await createPhase10Rig()
  console.log('adapter:', rig.adapterInfo, ' ssaa:', `${SSAA}x${SSAA}`)

  // ---- stimuli ------------------------------------------------------------
  const jpg = fs.readFileSync(path.join('stuff', '5468102179_8f885a1744_o.jpg'))
  const decoded = await rig.decodeImage(new Uint8Array(jpg), 'image/jpeg', 2400)
  const photo = coverCrop(decoded, W, H)
  // Heavily band-limited: the point is that the SOURCE contains no adjacent-pixel
  // jump bigger than a couple of levels, so every large jump in the OUTPUT is the
  // map's doing. sigma is chosen by the calibration gate below, not by eye.
  const smooth = blur(photo, 9.0)
  const diag = aaDiagonal(W, H, 30)            // pre-antialiased oblique edge
  save('stim-photo', photo)
  save('stim-smooth', smooth)
  save('stim-aa-diagonal30', diag)

  // ---- METRIC CALIBRATION -------------------------------------------------
  const calib: Record<string, unknown> = {}
  {
    const dSmooth = discontinuity(smooth)
    const dPhoto = discontinuity(photo)
    const dDiag = discontinuity(diag)
    const bad20 = discontinuity(hardCutField(W, H, 20, 80))
    const bad60 = discontinuity(hardCutField(W, H, 60, 80))
    calib.discontinuity = {
      goodSmoothSource: +dSmooth.p999.toFixed(2),
      goodAaDiagonalSource: +dDiag.p999.toFixed(2),
      photoSource: +dPhoto.p999.toFixed(2),
      badSyntheticCut20: +bad20.p999.toFixed(2),
      badSyntheticCut60: +bad60.p999.toFixed(2),
    }
    // The absolute floor of a real photo is a REFERENCE level, not a gate — a
    // photo legitimately contains steep gradients. The gate that matters is that
    // the metric reads a synthetic cut back at its true amplitude.
    const okBad = Math.abs(bad20.p999 - 20) < 1 && Math.abs(bad60.p999 - 60) < 1
    console.log('\n[calibration] discontinuity = p99.9 adjacent-pixel luma jump, 0..255 levels')
    console.log(`  smooth-source floor            ${dSmooth.p999.toFixed(2)}  (reference; the identity render must reproduce it exactly)`)
    console.log(`  synthetic 20-level hard cut    ${bad20.p999.toFixed(2)}`)
    console.log(`  synthetic 60-level hard cut    ${bad60.p999.toFixed(2)}   KNOWN-BAD reads back true: ${okBad ? 'PASS' : 'FAIL'}`)
    console.log(`  aa-diagonal source ${dDiag.p999.toFixed(2)} / photo source ${dPhoto.p999.toFixed(2)}  (both contain real edges — not usable as floors)`)
    calib.gates = { knownBadReadsTrue: okBad }

    // run-structure calibration: the synthetic cut is a pure hard cut, so its
    // longRunFrac must be ~1; a shimmer field must be ~0.
    const rsBad = runStructure(bad20.field, W, H, 15)
    const noise = blank(W, H)
    let seed = 12345
    for (let i = 0; i < W * H; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const v = 120 + ((seed >>> 24) % 40)
      noise.data[i * 4] = v; noise.data[i * 4 + 1] = v; noise.data[i * 4 + 2] = v
    }
    const rsNoise = runStructure(discontinuity(noise).field, W, H, 15)
    console.log(`[calibration] runStructure longRunFrac — synthetic hard cut ${rsBad.longRunFrac.toFixed(3)} (expect ~1), ` +
      `white noise ${rsNoise.longRunFrac.toFixed(3)} (expect ~0)`)
    calib.runStructure = { hardCutLongRunFrac: +rsBad.longRunFrac.toFixed(3), noiseLongRunFrac: +rsNoise.longRunFrac.toFixed(3) }
  }

  // ---- analytic derivative -------------------------------------------------
  const analytic: Record<string, unknown> = {}
  for (const [ior, curv] of [[1.5, 0.8], [1.1, 0.8], [3.0, 0.8], [1.5, 0.05], [1.5, 2.0]] as const) {
    const p = derivativeProfile(ior, curv)
    analytic[`ior${ior}_curv${curv}`] = {
      dCentre: +p.atCentre.toFixed(4), dEdge: +p.atEdge.toFixed(4),
      maxAbsDerivative: +p.maxAbs.toFixed(4),
      minifiesAnywhere: p.maxAbs > 1,
      zeroCrossings: p.zeroCrossings, minAbsDerivative: +p.minAbs.toFixed(5),
      seamJumpInRibWidths: +p.seamJumpRibs.toFixed(4),
    }
  }
  console.log('\n[analytic] d(sampled)/d(screen) inside one rib, and the seam jump:')
  for (const [k, v] of Object.entries(analytic)) console.log('  ', k, JSON.stringify(v))

  // ---- matrix -------------------------------------------------------------
  interface Row {
    name: string; note?: string
    /** worst adjacent-pixel luma jump (p99.9), 1 tap */
    dP999_1tap: number
    /** ... and after SSAA. What SSAA cannot remove is a true C0 step. */
    hardCutAmp: number
    /** the part SSAA does remove = intra-pixel aliasing */
    aliasAmp: number
    ssaaReductionPct: number
    ssaaRms: number; ssaaMax: number
    hotCount: number; longRunFrac: number; isolatedFrac: number; runAxis: string
    /** analytic: how far the sampled position jumps across one seam, in device px */
    seamJumpPx: number
    /** how many seam lines cross the 1200 px frame */
    seamLines: number
    verdict: string
  }
  const rows: Row[] = []
  const cases = QUICK ? CASES.filter((_, i) => i % 3 === 0) : CASES
  const srcFloor = discontinuity(smooth).p999
  console.log(`\n[matrix] smooth-source discontinuity floor = ${srcFloor.toFixed(2)} levels; ` +
    'hardCut = what survives SSAA, alias = what SSAA removes\n')

  for (const c of cases) {
    const one = await render(rig, c.cfg, smooth, { dpr: c.dpr })
    const ss = await render(rig, c.cfg, smooth, { dpr: c.dpr, ssaa: SSAA })
    const d1 = discontinuity(one), d2 = discontinuity(ss)
    const r = rms(one, ss)
    const rs = runStructure(d1.field, W, H, Math.max(6, d1.p999 * 0.6))
    const alias = d1.p999 - d2.p999
    const dev = (c.dpr ?? 1)
    const jumpPx = derivativeProfile(c.cfg.ior ?? 1.5, c.cfg.curvature ?? 0.8).seamJumpRibs * (c.cfg.ribWidth ?? 80) * dev
    const verdict = d1.p999 < srcFloor * 1.5 ? 'clean'
      : alias < 3 ? 'HARD CUT, seam on the pixel grid — supersampling is a no-op'
        : rs.longRunFrac > 0.5 ? 'HARD CUT, straight but off-grid — SSAA buys a 1-px blend only'
          : 'STAIRCASE on top of a hard cut — SSAA removes the jaggies, not the cut'
    rows.push({
      name: c.name, note: c.note,
      dP999_1tap: +d1.p999.toFixed(2),
      hardCutAmp: +d2.p999.toFixed(2),
      aliasAmp: +alias.toFixed(2),
      ssaaReductionPct: +(100 * (1 - d2.p999 / Math.max(d1.p999, 1e-6))).toFixed(1),
      ssaaRms: +r.rms.toFixed(2), ssaaMax: r.max,
      hotCount: rs.count, longRunFrac: +rs.longRunFrac.toFixed(3),
      isolatedFrac: +rs.isolatedFrac.toFixed(3), runAxis: rs.axis,
      seamJumpPx: +jumpPx.toFixed(1),
      seamLines: Math.round(W / ((c.cfg.ribWidth ?? 80) * dev)),
      verdict,
    })
    console.log(`  ${c.name.padEnd(26)} 1tap=${d1.p999.toFixed(1).padStart(5)}  hardCut=${d2.p999.toFixed(1).padStart(5)}  ` +
      `alias=${alias.toFixed(1).padStart(6)}  ` +
      `ssaaRms=${r.rms.toFixed(2).padStart(5)} max=${String(r.max).padStart(3)}  ` +
      `run=${rs.longRunFrac.toFixed(2)}${rs.axis}  jump=${jumpPx.toFixed(0).padStart(4)}px  ${verdict}`)

    // photo renders for looking at
    const photoOut = await render(rig, c.cfg, photo, { dpr: c.dpr })
    save(`full-photo-${c.name}`, photoOut)
    const cx = c.cfg.srt_rotate ? 560 : 540
    save(`crop4x-photo-${c.name}`, crop(photoOut, cx, 340, 160, 120, 4))
    save(`crop4x-smooth-${c.name}`, crop(one, cx, 340, 160, 120, 4))
    save(`crop4x-smooth-ssaa-${c.name}`, crop(ss, cx, 340, 160, 120, 4))
    save(`cmp4x-smooth-1tap-vs-ssaa-${c.name}`,
      sideBySide(crop(one, cx, 340, 160, 120, 4), crop(ss, cx, 340, 160, 120, 4)))
    // 8x on a 70x50 window pinned tight to a seam — staircase vs hard cut is
    // unambiguous at this zoom.
    save(`cmp8x-seam-1tap-vs-ssaa-${c.name}`,
      sideBySide(crop(one, 582, 380, 70, 50, 8), crop(ss, 582, 380, 70, 50, 8)))
    save(`cmp8x-seam-photo-${c.name}`, crop(photoOut, 582, 380, 70, 50, 8))
  }

  // ---- CALIBRATION OF THE DISCRIMINATOR ITSELF ----------------------------
  // "alias = D999(1 tap) - D999(SSAA)" is the number the whole study turns on, so
  // it needs both a negative and a positive control drawn from real renders:
  //   negative — the identity lens: nothing to antialias, alias must be ~0 AND the
  //              hard-cut reading must land exactly on the source floor;
  //   positive — the SAME default lens with the pattern nudged half a pixel, which
  //              moves every seam off the pixel grid. If alias still read ~0 there,
  //              the metric would be blind rather than the artefact being a cut.
  {
    const a00 = rows.find(r => r.name === 'A00-identity-ior1')!
    const a02 = rows.find(r => r.name === 'A02-default-halfpx-phase')!
    const negOk = Math.abs(a00.aliasAmp) < 1 && Math.abs(a00.hardCutAmp - srcFloor) < 0.5
    const posOk = a02.aliasAmp > 10
    console.log(`\n[calibration] discriminator controls`)
    console.log(`  negative (identity lens)      alias=${a00.aliasAmp.toFixed(2)}  hardCut=${a00.hardCutAmp.toFixed(2)} vs floor ${srcFloor.toFixed(2)}   ${negOk ? 'PASS' : 'FAIL'}`)
    console.log(`  positive (same lens, +0.5 px) alias=${a02.aliasAmp.toFixed(2)}                                    ${posOk ? 'PASS' : 'FAIL'}`)
    calib.discriminator = { negativeControlPasses: negOk, positiveControlPasses: posOk, sourceFloor: +srcFloor.toFixed(2) }
  }

  // ---- 1-D luma profile straight across one seam --------------------------
  console.log('\n[seam profile] row 400, columns 592..607 (a seam sits at x = 599.5 for ribWidth 80):')
  const profiles: Record<string, number[]> = {}
  for (const c of CASES.filter(c => ['A00-identity-ior1', 'A01-default', 'B01-rib160', 'E02-ior1p1', 'D01-bow0'].includes(c.name))) {
    const one = await render(rig, c.cfg, smooth, { dpr: c.dpr })
    const ss = await render(rig, c.cfg, smooth, { dpr: c.dpr, ssaa: SSAA })
    const p1: number[] = [], p2: number[] = []
    for (let x = 592; x <= 607; x++) { p1.push(+luma(one, x, 400).toFixed(1)); p2.push(+luma(ss, x, 400).toFixed(1)) }
    profiles[c.name] = p1
    profiles[`${c.name}__ssaa${SSAA}`] = p2
    console.log(`  ${c.name.padEnd(20)} 1tap  ${p1.map(v => v.toFixed(0).padStart(4)).join('')}`)
    console.log(`  ${''.padEnd(20)} ssaa  ${p2.map(v => v.toFixed(0).padStart(4)).join('')}`)
  }

  // ---- oblique-edge stimulus: staircase test ------------------------------
  console.log('\n[oblique edge] pre-antialiased 30-degree edge through the lens:')
  const edgeRows: Array<Record<string, unknown>> = []
  for (const c of CASES.filter(c => ['A00-identity-ior1', 'A01-default', 'C02-rot23', 'B03-rib20', 'C04-rot23-rib20'].includes(c.name))) {
    const one = await render(rig, c.cfg, diag, { dpr: c.dpr })
    const ss = await render(rig, c.cfg, diag, { dpr: c.dpr, ssaa: SSAA })
    save(`full-diag-${c.name}`, one)
    save(`crop4x-diag-${c.name}`, crop(one, 540, 340, 160, 120, 4))
    save(`cmp4x-diag-1tap-vs-ssaa-${c.name}`,
      sideBySide(crop(one, 540, 340, 160, 120, 4), crop(ss, 540, 340, 160, 120, 4)))
    const d1 = discontinuity(one), d2 = discontinuity(ss)
    const r = rms(one, ss)
    edgeRows.push({ name: c.name, dP999_1tap: +d1.p999.toFixed(2), dP999_ssaa: +d2.p999.toFixed(2), ssaaRms: +r.rms.toFixed(2), ssaaMax: r.max })
    console.log(`  ${c.name.padEnd(26)} D999 1tap=${d1.p999.toFixed(1)} ssaa=${d2.p999.toFixed(1)} rms=${r.rms.toFixed(2)} max=${r.max}`)
  }

  // ---- engine-level contributor: ANIMATED_DPR_SCALE = 0.75 -----------------
  console.log('\n[engine] ANIMATED_DPR_SCALE — 0.75x render then browser upscale:')
  const dprRows: Array<Record<string, unknown>> = []
  for (const cfgName of ['straight', 'rot23'] as const) {
    const cfg = cfgName === 'straight' ? BASE : { ...BASE, srt_rotate: 23 }
    for (const [label, scale] of [['static-1.00', 1], ['animated-0.75', 0.75], ['animated-0.50', 0.5]] as const) {
      const w = Math.round(W * scale), h = Math.round(H * scale)
      const out = await render(rig, cfg, photo, { dpr: scale, w, h })
      const up = scale === 1 ? out : bilinearResize(out, W, H)
      save(`full-photo-dprscale-${cfgName}-${label}`, up)
      save(`crop4x-photo-dprscale-${cfgName}-${label}`, crop(up, 540, 340, 160, 120, 4))
      save(`crop8x-photo-dprscale-${cfgName}-${label}`, crop(up, 582, 380, 70, 50, 8))
      const outS = await render(rig, cfg, smooth, { dpr: scale, w, h })
      const upS = scale === 1 ? outS : bilinearResize(outS, W, H)
      const d = discontinuity(upS)
      dprRows.push({ cfg: cfgName, label, buffer: `${w}x${h}`, ribDevicePx: 80 * scale, dP999: +d.p999.toFixed(2) })
      console.log(`  ${cfgName.padEnd(9)} ${label.padEnd(16)} buffer ${w}x${h}  rib=${80 * scale}px  D999=${d.p999.toFixed(1)}`)
    }
  }

  // ---- the ceiling: 1-tap vs 16x16 on the photo, default config -----------
  {
    const one = await render(rig, BASE, photo)
    const ss = await render(rig, BASE, photo, { ssaa: SSAA })
    save('ceiling-full-1tap', one)
    save('ceiling-full-ssaa', ss)
    save('ceiling-cmp4x', sideBySide(crop(one, 540, 340, 160, 120, 4), crop(ss, 540, 340, 160, 120, 4)))
    const r = rms(one, ss)
    console.log(`\n[ceiling] default config, photo: 1-tap vs ${SSAA}x${SSAA} — rms=${r.rms.toFixed(2)} max=${r.max}`)
    calib.ceilingDefaultPhoto = { rms: +r.rms.toFixed(2), max: r.max }
  }

  fs.writeFileSync(path.join(OUT, '..', 'phase10-repro.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), adapter: rig.adapterInfo,
    resolution: `${W}x${H}`, ssaa: SSAA, calibration: calib, analytic, matrix: rows,
    seamProfilesRow400Cols592to607: profiles, obliqueEdge: edgeRows, dprScale: dprRows,
  }, null, 2))

  await rig.close()
  console.log(`\nwrote ${fs.readdirSync(OUT).length} PNGs to ${OUT}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
