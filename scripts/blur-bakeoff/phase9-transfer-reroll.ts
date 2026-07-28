/**
 * Phase 9 transfer — the one temporal case the bake-off never measured: a
 * CANVAS RESIZE.
 *
 * The shipped 4*u_dpr lattice exists to stop the grain re-randomising on resize.
 * The bench measured a DPR-tier flip (2.0 -> 1.5) and a full seed re-roll, but
 * never a resize, so the winner's headline result is silent about the exact
 * thing the defect it replaces was protecting.
 *
 * Both seeds are derived from the node's own expression. With u_anchor = 0.5,
 * u_ref_size = 512:
 *
 *   rg_coords.y = (d_ydown - u_resolution.y*0.5) / (u_dpr*512) + 0.5
 *
 *   shipped lattice   gc = floor(rg_coords * (u_ref_size*0.25))
 *                        = floor((d - res.y*0.5)/(u_dpr*4) + 64)
 *                     res.y += 1  =>  argument shifts by -0.5/(u_dpr*4)
 *                                  =  -0.0625 cells at DPR 2
 *
 *   per-device-pixel  gc = floor(rg_coords * (u_dpr*u_ref_size))
 *                        = floor(d - res.y*0.5 + 0.5*u_dpr*512)
 *                     res.y += 1  =>  argument shifts by -0.5 px
 *
 * So the experiment is: render, shift the seed argument by that amount, render
 * again, and measure how much of the frame changed. A one-device-pixel height
 * change is one frame of a window drag.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase9-transfer-reroll.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRig, type PassSpec, type Rig } from './lib/gpu-rig'
import type { Rgba8 } from './lib/image'
import {
  frostIngestPass, frostEgressPass, frostGatherPass, assertLive,
  type FrostKernel,
} from './lib/frost-bench'
import { deviation, insetRoi } from './lib/frost-metrics'

const OUT = path.join('reports', 'blur-bakeoff', 'phase9')
const SIZE = 512

function centerCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const cw = Math.min(w, img.width), ch = Math.min(h, img.height)
  const x0 = ((img.width - cw) / 2) | 0, y0 = ((img.height - ch) / 2) | 0
  const out: Rgba8 = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      for (let c = 0; c < 4; c++) out.data[(y * cw + x) * 4 + c] = img.data[((y + y0) * img.width + (x + x0)) * 4 + c]
  return out
}

/** Shift the seed ARGUMENT (inside floor) by dy, exactly as a resize does. */
function shiftSeed(spec: PassSpec, kind: 'lattice' | 'pixel', dy: number): PassSpec {
  const d = dy.toPrecision(9)
  let body = spec.body
  if (kind === 'pixel') {
    const before = body
    body = body.replace('floor(fpx)', `floor(fpx + vec2(0.0, ${d}))`)
    if (body === before) throw new Error('pixel seed line not found — emitter changed')
  } else {
    const before = body
    body = body.replace('+ vec2(64.0))', `+ vec2(64.0) + vec2(0.0, ${d}))`)
    if (body === before) throw new Error('lattice seed line not found — emitter changed')
  }
  return { ...spec, body }
}

async function cap(rig: Rig, input: Rgba8, k: FrostKernel, radius: number, dpr: number, seedShift: number | null, kind: 'lattice' | 'pixel', phase = 0): Promise<Rgba8> {
  const gather = frostGatherPass('webgpu', k)
  const passes: PassSpec[] = [
    frostIngestPass('webgpu'),
    seedShift === null ? gather : shiftSeed(gather, kind, seedShift),
    frostEgressPass('webgpu'),
  ]
  const out = await rig.capture({
    backend: 'webgpu', width: input.width, height: input.height, input,
    radius, params: [1, phase, dpr, 0], passes,
  })
  assertLive(out, 'reroll')
  return out
}

interface Row {
  cand: string
  seed: 'lattice' | 'pixel'
  taps: number
  radiusCssPx: number
  perturbation: string
  meanAbs: number
  p99: number
  changedFrac: number
}

function changedFraction(a: Rgba8, b: Rgba8, roi: { x0: number; y0: number; x1: number; y1: number }, thr: number): number {
  let n = 0, hit = 0
  for (let y = roi.y0; y < roi.y1; y++)
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = (y * a.width + x) * 4
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      )
      n++
      if (d >= thr) hit++
    }
  return hit / n
}

async function main() {
  const rig = await createRig()
  const rows: Row[] = []
  try {
    const bytes = new Uint8Array(fs.readFileSync('stuff/2013-03-12 00.48.07.jpg'))
    const input = centerCrop(await rig.decodeImage(bytes, 'image/jpeg', 1024), SIZE, SIZE)
    const dpr = 2

    const CANDS: Array<{ id: string; k: FrostKernel; seed: 'lattice' | 'pixel'; dyResize: number }> = [
      { id: 'C0 shipped 8-tap lattice', k: { taps: 8, pattern: 'squareHash', seed: 'lattice' }, seed: 'lattice', dyResize: 0.5 / (dpr * 4) },
      { id: 'C3j-16 winner (per-device-px)', k: { taps: 16, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash' }, seed: 'pixel', dyResize: 0.5 },
      { id: 'C3j-24 (per-device-px)', k: { taps: 24, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash' }, seed: 'pixel', dyResize: 0.5 },
      { id: 'C7 ground truth 256', k: { taps: 256, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash', emit: 'procedural' }, seed: 'pixel', dyResize: 0.5 },
    ]

    for (const frost of [0.5, 1]) {
      const R = frost * 24 * dpr
      const roi = insetRoi(SIZE, SIZE, Math.ceil(1.5 * R) + 8)
      for (const c of CANDS) {
        const base = await cap(rig, input, c.k, R, dpr, null, c.seed)

        // NULL CONTROL — identical shader, must be exactly 0.
        const same = await cap(rig, input, c.k, R, dpr, 0, c.seed)
        const dz = deviation(base, same, roi)
        rows.push({ cand: c.id, seed: c.seed, taps: c.k.taps, radiusCssPx: frost * 24, perturbation: 'NULL control (dy=0)', meanAbs: dz.coveredMeanAbs, p99: dz.p99Abs, changedFrac: changedFraction(base, same, roi, 2) })

        // 1 device-px canvas height change.
        const rs = await cap(rig, input, c.k, R, dpr, c.dyResize, c.seed)
        const dr = deviation(base, rs, roi)
        rows.push({ cand: c.id, seed: c.seed, taps: c.k.taps, radiusCssPx: frost * 24, perturbation: `resize +1 device px (dy=${c.dyResize})`, meanAbs: dr.coveredMeanAbs, p99: dr.p99Abs, changedFrac: changedFraction(base, rs, roi, 2) })

        // 8 device-px height change (a slow drag frame).
        const rs8 = await cap(rig, input, c.k, R, dpr, c.dyResize * 8, c.seed)
        const dr8 = deviation(base, rs8, roi)
        rows.push({ cand: c.id, seed: c.seed, taps: c.k.taps, radiusCssPx: frost * 24, perturbation: `resize +8 device px`, meanAbs: dr8.coveredMeanAbs, p99: dr8.p99Abs, changedFrac: changedFraction(base, rs8, roi, 2) })

        // FULL re-roll upper bound (integer seed phase) — the bench's number.
        const rr = await cap(rig, input, c.k, R, dpr, null, c.seed, 1)
        const drr = deviation(base, rr, roi)
        rows.push({ cand: c.id, seed: c.seed, taps: c.k.taps, radiusCssPx: frost * 24, perturbation: 'FULL re-roll (upper bound)', meanAbs: drr.coveredMeanAbs, p99: drr.p99Abs, changedFrac: changedFraction(base, rr, roi, 2) })
      }
    }
  } finally {
    await rig.close()
  }

  const r2 = (v: number) => Math.round(v * 100) / 100
  const pad = (s: unknown, n: number) => String(s).padEnd(n)
  const padL = (s: unknown, n: number) => String(s).padStart(n)
  console.log(`\n${pad('candidate', 30)}${padL('Rcss', 6)}${pad('  perturbation', 32)}${padL('mean|d|', 9)}${padL('p99', 6)}${padL('changed%', 10)}`)
  for (const r of rows)
    console.log(`${pad(r.cand, 30)}${padL(r.radiusCssPx, 6)}${pad('  ' + r.perturbation, 32)}${padL(r2(r.meanAbs), 9)}${padL(r.p99, 6)}${padL(r2(r.changedFrac * 100), 10)}`)

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'phase9-transfer-reroll.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2))
}
main()
