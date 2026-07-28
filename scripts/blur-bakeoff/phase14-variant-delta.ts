/**
 * Phase 14 helper — two deltas the convergence ladder implies but does not print.
 *
 *  1) |GT64(shipped node) - GT64(split-disabled node)| — the SIZE of the
 *     self-filtering ground-truth hazard at the user's config. Phase 12 measured
 *     up to 32 codes on its own matrix; this is the number for curvature 2.15 on
 *     both stimuli. If it is large, the choice of GT node changes rankings.
 *
 *  2) |1tap(shipped) - 1tap(split-disabled)| — what the shipped seam-coverage AA
 *     actually DOES at the user's config, measured rather than asserted.
 *
 * Reads the frames phase14-gt-convergence.ts wrote. 8-bit PNGs, so every number
 * carries a +-0.5 code rounding floor; both quantities are far above it.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase14-variant-delta.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from './lib/png.ts'
import type { Rgba8 } from './lib/image.ts'

const DIR = path.join(process.cwd(), 'reports', 'blur-bakeoff', 'phase14')
const MARGIN = 6

function load(name: string): Rgba8 {
  return decodePng(new Uint8Array(fs.readFileSync(path.join(DIR, name))))
}

function stats(a: Rgba8, b: Rgba8): { mean: number; rmse: number; p999: number; max: number; nGe1: number; nGe8: number; nPx: number } {
  const vals: number[] = []
  let sq = 0
  let n = 0
  let ge1 = 0
  let ge8 = 0
  for (let y = MARGIN; y < a.height - MARGIN; y++) {
    for (let x = MARGIN; x < a.width - MARGIN; x++) {
      const o = (y * a.width + x) * 4
      let d = 0
      for (let c = 0; c < 3; c++) {
        const e = a.data[o + c] - b.data[o + c]
        sq += e * e
        d = Math.max(d, Math.abs(e))
      }
      vals.push(d)
      n++
      if (d >= 1) ge1++
      if (d >= 8) ge8++
    }
  }
  vals.sort((p, q) => p - q)
  return {
    mean: vals.reduce((p, q) => p + q, 0) / n,
    rmse: Math.sqrt(sq / (n * 3)),
    p999: vals[Math.floor(n * 0.999)],
    max: vals[n - 1],
    nGe1: ge1, nGe8: ge8, nPx: n,
  }
}

const f = (s: ReturnType<typeof stats>): string =>
  `mean ${s.mean.toFixed(3)}  rmse ${s.rmse.toFixed(3)}  p99.9 ${s.p999}  max ${s.max}  ` +
  `>=1 code ${(100 * s.nGe1 / s.nPx).toFixed(2)}%  >=8 codes ${(100 * s.nGe8 / s.nPx).toFixed(2)}%`

for (const stim of ['hicon', 'flat']) {
  console.log(`\n--- ${stim} @ the user's config (curvature 2.15) ---`)
  const gtS = load(`frame-curv2p15_${stim}_shipped-N64.png`)
  const gtN = load(`frame-curv2p15_${stim}_nosplit-N64.png`)
  const t1S = load(`frame-curv2p15_${stim}_shipped-N1.png`)
  const t1N = load(`frame-curv2p15_${stim}_nosplit-N1.png`)
  console.log(`  GT64(shipped) vs GT64(nosplit) — self-filtering GT hazard : ${f(stats(gtS, gtN))}`)
  console.log(`  1tap(shipped) vs 1tap(nosplit) — what the shipped AA does : ${f(stats(t1S, t1N))}`)
}
