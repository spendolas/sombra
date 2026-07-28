/**
 * Phase 10d — WORST-CASE LOOK AUDIT of the phase-10b winner (A3, RGSS 4-rook).
 *
 * phase10-look-verify.ts picks its crop window by (local contrast x seam
 * presence) measured on the GROUND TRUTH. That window is where the seam is most
 * legible, not where the WINNER is worst. Two things are therefore missing from
 * the proof pack:
 *
 *   1. No full-frame A3 render exists anywhere. `full-<cfg>-A0.png` and
 *      `-A8.png` do, so the single largest visible A0-vs-GT difference in the
 *      matrix (the high-frequency crinkle that fills the rib INTERIORS at
 *      curvature 1.5, ~76% of the frame) has never been shown with the fix on.
 *   2. The sweep ranked on mean / p95 and never reported edgeRoughnessMax,
 *      which is in phase10.json. On the oblique + straddling configs A4's max
 *      is 2-3x lower than A3's. This script crops where |A3 - A8| is largest.
 *
 * Writes only reports/blur-bakeoff/phase10/worst/. Read-only w.r.t. src/.
 *
 * Run:  npx tsx scripts/blur-bakeoff/phase10-look-worst.ts
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  buildGraph, candidatePasses, CANDIDATE_BY_ID, CONFIGS,
  type BenchConfig, type ReedCfg, type StimulusId,
} from './phase10-reed-aa.ts'
import { createAaRig, type AaRig, type Backend } from './phase10-aa-rig.ts'
import type { Rgba8 } from './lib/image.ts'
import { encodePng } from './lib/png.ts'

const REPO = process.cwd()
const OUT = path.join(REPO, 'reports', 'blur-bakeoff', 'phase10', 'worst')
const W = 1200
const H = 800
const MARGIN = 12

const CANDS = ['A0', 'A4', 'A3', 'A8']

// --- stimuli (verbatim from phase10-reed-aa.ts / -look-verify.ts) -----------

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
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
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
      const v = (x % spacing === 0 || y % spacing === 4) ? 245 : 10
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
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

// --- image helpers ----------------------------------------------------------

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

function writePng(name: string, img: Rgba8): string {
  fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, name)
  fs.writeFileSync(p, encodePng(img))
  return p
}

function dmax(a: Rgba8, b: Rgba8, i: number): number {
  const o = i * 4
  return Math.max(
    Math.abs(a.data[o] - b.data[o]),
    Math.abs(a.data[o + 1] - b.data[o + 1]),
    Math.abs(a.data[o + 2] - b.data[o + 2]),
  )
}

/** window (size x size) maximising the mean of |a - b|; the loser's worst place */
function worstWindow(a: Rgba8, b: Rgba8, size: number): { x: number; y: number; score: number } {
  let best = { x: MARGIN, y: MARGIN, score: -1 }
  for (let y = MARGIN; y + size < H - MARGIN; y += 4) {
    for (let x = MARGIN; x + size < W - MARGIN; x += 4) {
      let s = 0
      for (let j = 0; j < size; j += 2) {
        for (let i = 0; i < size; i += 2) s += dmax(a, b, (y + j) * W + (x + i))
      }
      if (s > best.score) best = { x, y, score: s }
    }
  }
  best.score /= (size / 2) ** 2
  return best
}

/**
 * Coverage quantisation. For every pixel in the band, |value - GT value| is the
 * coverage error. A candidate that resolves coverage with K sub-pixel samples
 * can only produce K+1 coverage levels, so the DISTRIBUTION of its residual is
 * multi-modal with modes at (j/K - true) * jump. We report the count of
 * residual levels that hold >2% of the band each, after quantising to 4 codes.
 */
function residualModes(cand: Rgba8, gt: Rgba8, band: Uint8Array): { modes: number; top: number[] } {
  const hist = new Map<number, number>()
  let n = 0
  for (let i = 0; i < W * H; i++) {
    if (!band[i]) continue
    const q = Math.round(dmax(cand, gt, i) / 4) * 4
    hist.set(q, (hist.get(q) ?? 0) + 1)
    n++
  }
  const kept = [...hist.entries()].filter(([, c]) => c / n > 0.02).sort((p, q) => q[1] - p[1])
  return { modes: kept.length, top: kept.slice(0, 8).map(([v]) => v) }
}

// --- render -----------------------------------------------------------------

function periodPx(cfg: ReedCfg, dpr: number): number {
  return (cfg.ribWidth ?? 80) * dpr * (cfg.srt_scale ?? 1)
}

async function loadStimuli(rig: AaRig): Promise<Map<StimulusId, Rgba8>> {
  const m = new Map<StimulusId, Rgba8>()
  const bytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'stuff', '5468102179_8f885a1744_o.jpg')))
  m.set('photo', coverCrop(await rig.decodeImage(bytes, 'image/jpeg', 2048), W, H))
  m.set('noise', hfNoise(W, H))
  m.set('lines', thinLines(W, H))
  m.set('ramp-x', ramp(W, H))
  m.set('step', stepImg(W, H))
  return m
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

// --- gates ------------------------------------------------------------------

interface Gate { id: string; what: string; good: string; bad: string; pass: boolean }

function gateWorstWindow(): Gate[] {
  // known-good: locator must find an injected error block; known-bad: it must
  // NOT report the block position on an identical pair.
  const mk = (): Rgba8 => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) })
  const a = mk(); const b = mk()
  for (let i = 3; i < a.data.length; i += 4) { a.data[i] = 255; b.data[i] = 255 }
  const BX = 700; const BY = 300
  for (let y = BY; y < BY + 24; y++) {
    for (let x = BX; x < BX + 24; x++) {
      const o = (y * W + x) * 4
      a.data[o] = 200; a.data[o + 1] = 200; a.data[o + 2] = 200
    }
  }
  const hit = worstWindow(a, b, 24)
  const found = Math.abs(hit.x - BX) <= 4 && Math.abs(hit.y - BY) <= 4
  const flat = worstWindow(b, b, 24)
  return [
    { id: 'W1', what: 'worst-window locator finds an injected 24x24 block',
      good: `found (${hit.x},${hit.y}) score=${hit.score.toFixed(1)}`,
      bad: `truth (${BX},${BY})`, pass: found && hit.score > 60 },
    { id: 'W2', what: 'locator scores 0 on an identical pair',
      good: `score=${flat.score.toFixed(3)}`, bad: 'nonzero would mean noise floor', pass: flat.score === 0 },
  ]
}

function gateModes(): Gate[] {
  // known-bad: a 2-level residual (a hard step, i.e. what A0 does) -> 2 modes.
  // known-good: a continuous residual ramp -> many modes.
  const band = new Uint8Array(W * H)
  for (let y = 100; y < 700; y++) for (let x = 100; x < 1100; x++) band[y * W + x] = 1
  const mk = (f: (x: number, y: number) => number): Rgba8 => {
    const d = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4
        const v = f(x, y)
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
      }
    }
    return { width: W, height: H, data: d }
  }
  const zero = mk(() => 0)
  const twoLevel = mk((x) => (x % 2 === 0 ? 0 : 60))
  const rampR = mk((x) => (x - 100) % 61)
  const q2 = residualModes(twoLevel, zero, band)
  const qr = residualModes(rampR, zero, band)
  return [
    { id: 'W3', what: 'residual-mode count: 2-level known-bad reads few modes',
      good: `modes=${q2.modes} top=${q2.top.join(',')}`, bad: 'a smooth residual must read more', pass: q2.modes <= 3 },
    { id: 'W4', what: 'residual-mode count: continuous known-good reads many modes',
      good: `modes=${qr.modes}`, bad: `2-level reads ${q2.modes}`, pass: qr.modes >= 8 },
  ]
}

// --- main -------------------------------------------------------------------

const TARGETS = ['curv1p5', 'misaligned', 'rot45', 'wave-sine', 'rot15', 'ior2p5', 'default']

async function main(): Promise<void> {
  const gates: Gate[] = [...gateWorstWindow(), ...gateModes()]
  for (const g of gates) console.log(`${g.pass ? 'PASS' : 'FAIL'} ${g.id}: ${g.what} | ${g.good} | ${g.bad}`)
  if (gates.some((g) => !g.pass)) throw new Error('calibration gate failed — metrics not trustworthy')

  const rig = await createAaRig()
  const backend: Backend = rig.available.webgpu ? 'webgpu' : 'webgl2'
  const out: Record<string, unknown> = { generated: new Date().toISOString(), backend, gates, configs: {} }
  try {
    const stimuli = await loadStimuli(rig)
    for (const id of TARGETS) {
      const bc = CONFIGS.find((c) => c.id === id)!
      const stim = stimuli.get(bc.stimulus)!
      const imgs: Record<string, Rgba8> = {}
      for (const c of CANDS) imgs[c] = await render(rig, stim, bc, c, backend)
      const gt = imgs['A8']

      // full frames for the winner and today, so the interior can be compared
      writePng(`full-${id}-A3.png`, imgs['A3'])
      if (id === 'curv1p5' || id === 'misaligned') {
        writePng(`full-${id}-A0.png`, imgs['A0'])
        writePng(`full-${id}-A8.png`, gt)
      }

      // crop where the WINNER is worst
      const w3 = worstWindow(imgs['A3'], gt, 24)
      const w0 = worstWindow(imgs['A0'], gt, 24)
      const zoom = (win: { x: number; y: number }, tag: string): void => {
        writePng(`worst${tag}-${id}.png`, hstack(CANDS.map(
          (c) => upscaleNearest(crop(imgs[c], win.x, win.y, 24, 24), 14))))
      }
      zoom(w3, 'A3')
      zoom(w0, 'A0')

      const band = new Uint8Array(W * H)
      let nb = 0
      for (let i = 0; i < W * H; i++) {
        const y = Math.floor(i / W); const x = i % W
        if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) continue
        if (dmax(imgs['A0'], gt, i) >= 8) { band[i] = 1; nb++ }
      }
      const modes: Record<string, unknown> = {}
      for (const c of CANDS) modes[c] = residualModes(imgs[c], gt, band)

      const stat = (c: string): { mean: number; max: number; p999: number } => {
        const v: number[] = []
        let s = 0; let m = 0
        for (let i = 0; i < W * H; i++) {
          if (!band[i]) continue
          const d = dmax(imgs[c], gt, i)
          v.push(d); s += d; if (d > m) m = d
        }
        v.sort((p, q) => p - q)
        return { mean: s / v.length, max: m, p999: v[Math.floor(v.length * 0.999)] }
      }
      const st: Record<string, unknown> = {}
      for (const c of CANDS) st[c] = stat(c)

      ;(out.configs as Record<string, unknown>)[id] = {
        note: bc.note ?? '', bandPx: nb, bandFrac: nb / (W * H),
        worstA3Window: w3, worstA0Window: w0, modes, stat: st,
      }
      console.log(`${id}: band=${(nb / (W * H) * 100).toFixed(1)}%  ` +
        CANDS.map((c) => `${c} ${JSON.stringify(st[c])}`).join('  '))
      console.log(`   worstA3@(${w3.x},${w3.y}) ${w3.score.toFixed(1)}   ` +
        `worstA0@(${w0.x},${w0.y}) ${w0.score.toFixed(1)}   ` +
        CANDS.map((c) => `${c}modes=${(modes[c] as { modes: number }).modes}`).join(' '))
    }
  } finally {
    await rig.close()
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'look-worst.json'), JSON.stringify(out, null, 2))
  console.log(`\nwrote ${path.join(OUT, 'look-worst.json')}`)
}

void main()
