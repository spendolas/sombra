/**
 * Phase 5b — fix the radius pop found in Phase 5.
 *
 * Phase 5 showed the pyramid's output jumps 7.25x harder than its neighbours at
 * sigma 32, exactly where the level count steps from 2 to 3. Diagnosis: the
 * down/up chain is itself a blur, so its contribution jumps with the level count
 * while the coarse Gaussian's sigma drops, and the two do not cancel.
 *
 * Fix: measure how much blur the pyramid contributes at each level count, then
 * solve for the coarse sigma that lands the TOTAL on the requested value:
 *
 *     sigma_coarse = sqrt(max(0, sigma_target^2 - intrinsic^2(N))) / 2^N
 *
 * (variances add for successive Gaussian-ish blurs). Then re-run the sweep and
 * check the spike is gone.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase5b-fix.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Rig, type Backend, type PassSpec } from './lib/gpu-rig'
import {
  ingestPass, egressPass, linearSampledGaussPass,
  dualFilterDownPass, dualFilterUpPass,
} from './lib/shaders'
import { srgbToLinear } from './lib/color'
import type { Rgba8 } from './lib/image'
import { encodePng } from './lib/png'
import { hfNoise, stepEdge } from './lib/corpus'
import { sweepSpike } from './lib/temporal'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase5b')
const B: Backend = 'webgpu'
const SIZE = 384

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMG_DIR, `${name}.png`), encodePng(img))
}
function meanAbs(a: Rgba8, b: Rgba8): number {
  let s = 0, n = 0
  const px = Math.min(a.width * a.height, b.width * b.height)
  for (let p = 0; p < px; p++) for (let c = 0; c < 3; c++) { s += Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); n++ }
  return s / n
}

const levelsFor = (sigma: number) => Math.max(0, Math.min(5, Math.floor(Math.log2(sigma / 4))))

/** Build the pyramid with an explicit coarse sigma (0 = no coarse blur at all). */
function buildPyramid(levels: number, coarseSigma: number): PassSpec[] {
  const s = 1 / 2 ** levels
  const passes: PassSpec[] = []
  for (let i = 1; i <= levels; i++) passes.push({ ...dualFilterDownPass(B), scale: 1 / 2 ** i })
  if (coarseSigma > 0.15) {
    passes.push({ ...linearSampledGaussPass(B, coarseSigma, 'h'), scale: s })
    passes.push({ ...linearSampledGaussPass(B, coarseSigma, 'v'), scale: s })
  }
  for (let i = levels - 1; i >= 0; i--) passes.push({ ...dualFilterUpPass(B), scale: 1 / 2 ** i })
  return [ingestPass(B), ...passes, egressPass(B, { dither: true })]
}

/** Effective width from the 10-90% rise of a blurred step edge, in linear light. */
async function measureSigma(rig: Rig, passes: PassSpec[], size = 768): Promise<number> {
  const out = await rig.capture({ backend: B, width: size, height: 32, input: stepEdge(size, 32), passes })
  const prof: number[] = []
  for (let x = 0; x < out.width; x++) prof.push(srgbToLinear(out.data[(16 * out.width + x) * 4] / 255))
  const lo = Math.min(...prof)
  const hi = Math.max(...prof)
  if (hi - lo < 0.05) return NaN
  const cross = (target: number): number => {
    for (let x = 1; x < prof.length; x++) {
      if ((prof[x - 1] < target && prof[x] >= target) || (prof[x - 1] > target && prof[x] <= target)) {
        const d = prof[x] - prof[x - 1]
        return d === 0 ? x : x - 1 + (target - prof[x - 1]) / d
      }
    }
    return NaN
  }
  const a = cross(lo + 0.1 * (hi - lo))
  const b = cross(lo + 0.9 * (hi - lo))
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(b - a) / 2.563 : NaN
}

async function main() {
  const rig = await createRig()
  const report: Record<string, unknown> = {}
  try {
    // --- 1. how much blur does the bare pyramid contribute at each level? ----
    console.log('calibrating intrinsic pyramid blur per level...')
    const intrinsic: number[] = []
    for (let N = 0; N <= 5; N++) {
      const s = await measureSigma(rig, buildPyramid(N, 0))
      intrinsic[N] = Number.isFinite(s) ? s : 0
      console.log(`  levels ${N}: intrinsic sigma ${intrinsic[N].toFixed(2)}`)
    }
    report.intrinsic = intrinsic.map((v) => +v.toFixed(3))

    // --- 2. compensated build ----------------------------------------------
    const compensated = (sigma: number): PassSpec[] => {
      const N = levelsFor(sigma)
      const residual = Math.sqrt(Math.max(0, sigma * sigma - intrinsic[N] ** 2))
      return buildPyramid(N, residual / 2 ** N)
    }
    const naive = (sigma: number): PassSpec[] => buildPyramid(levelsFor(sigma), sigma / 2 ** levelsFor(sigma))

    // did compensation improve how closely we hit the requested width?
    console.log('checking width accuracy...')
    const accuracy: Array<Record<string, number>> = []
    for (const target of [6, 12, 20, 31.5, 32.5, 48]) {
      const n = await measureSigma(rig, naive(target))
      const c = await measureSigma(rig, compensated(target))
      accuracy.push({ target, naive: +n.toFixed(2), compensated: +c.toFixed(2) })
      console.log(`  sigma ${target}: naive ${n.toFixed(2)}, compensated ${c.toFixed(2)}`)
    }
    report.accuracy = accuracy

    // --- 3. sweep the EFFECTIVE width, which is what the eye tracks ---------
    // Mean-abs difference on blurred noise cannot see this: at large sigma the
    // image is already nearly flat, so even a 1.7-sigma jump moves pixels by only
    // ~0.17 codes. Measuring effective width directly makes the discontinuity
    // plain and interpretable — a 5% step in blur width IS what pops on screen.
    console.log('sweeping effective width...')
    const src = hfNoise(SIZE, SIZE, 77)
    const sigmas: number[] = []
    for (let s = 6; s <= 40; s += 0.5) sigmas.push(+s.toFixed(1))

    const widthSweep = async (build: (s: number) => PassSpec[]) => {
      const eff: number[] = []
      for (const s of sigmas) eff.push(await measureSigma(rig, build(s), 512))
      // A step of the sweep legitimately changes the width: requesting 0.5 more
      // sigma at sigma 6 is an 8% change. So score the OBSERVED change against
      // the EXPECTED one (d_sigma / sigma). ~1 means the family tracks the
      // request smoothly; >1 is excess movement, i.e. a discontinuity.
      const excess: number[] = []
      for (let i = 1; i < eff.length; i++) {
        const observed = Math.abs(eff[i] - eff[i - 1]) / Math.max(eff[i - 1], 1e-6)
        const expected = (sigmas[i] - sigmas[i - 1]) / sigmas[i - 1]
        excess.push(observed / Math.max(expected, 1e-6))
      }
      let worst = 0
      let idx = -1
      for (let i = 0; i < excess.length; i++) if (excess[i] > worst) { worst = excess[i]; idx = i }
      return { eff, excess, worstRatio: worst, worstAt: sigmas[idx + 1], spike: sweepSpike(excess) }
    }

    const before = await widthSweep(naive)
    console.log(`  naive:       width-tracking excess ${before.worstRatio.toFixed(2)}x at sigma ${before.worstAt}`)
    const after = await widthSweep(compensated)
    console.log(`  compensated: width-tracking excess ${after.worstRatio.toFixed(2)}x at sigma ${after.worstAt}`)

    // a monotone-ness check: does requested sigma always increase effective sigma?
    const monotone = (eff: number[]) => {
      let violations = 0
      for (let i = 1; i < eff.length; i++) if (eff[i] < eff[i - 1] - 0.15) violations++
      return violations
    }

    report.widthSweep = {
      naive: { worst_excess_ratio: +before.worstRatio.toFixed(2), at_sigma: before.worstAt, non_monotone_steps: monotone(before.eff) },
      compensated: { worst_excess_ratio: +after.worstRatio.toFixed(2), at_sigma: after.worstAt, non_monotone_steps: monotone(after.eff) },
      effective_at_thresholds: [16, 32].map((t) => {
        const i = sigmas.findIndex((s) => s >= t)
        return {
          requested: t,
          naive_before: +before.eff[i - 1].toFixed(2), naive_after: +before.eff[i].toFixed(2),
          compensated_before: +after.eff[i - 1].toFixed(2), compensated_after: +after.eff[i].toFixed(2),
        }
      }),
    }

    // --- 3b. hold the level count fixed ------------------------------------
    // If N never changes there is no level transition to pop through, and the
    // coarse sigma varies continuously. A fixed N only spans radii at or above
    // its own intrinsic blur, so N=2 is the one that covers this whole sweep.
    const FIXED_N = 2
    const fixedLevel = (sigma: number): PassSpec[] => {
      const residual = Math.sqrt(Math.max(0, sigma * sigma - intrinsic[FIXED_N] ** 2))
      return buildPyramid(FIXED_N, residual / 2 ** FIXED_N)
    }
    const fixed = await widthSweep(fixedLevel)
    console.log(`  fixed N=${FIXED_N}: width-tracking excess ${fixed.worstRatio.toFixed(2)}x at sigma ${fixed.worstAt}`)
    ;(report.widthSweep as Record<string, unknown>).fixed_level = {
      levels: FIXED_N,
      worst_excess_ratio: +fixed.worstRatio.toFixed(2),
      at_sigma: fixed.worstAt,
      non_monotone_steps: monotone(fixed.eff),
      covers_sigma_from: +intrinsic[FIXED_N].toFixed(2),
      taps_at_sigma40: fixedLevel(40).reduce((n, p) => n + (p.body.match(/sampleSrc\(/g)?.length ?? 0), 0),
    }

    // --- 3c. image-space sweep on STRUCTURED content ------------------------
    // The decisive visibility test. Blurred noise goes flat, so mean-abs there is
    // ~0.02 codes and any ratio against it is meaningless (that is what produced
    // the original 7.25x false alarm). A photograph keeps low-frequency structure
    // under heavy blur, so a width change really does move pixels and a pop would
    // show as a spike in consecutive-frame difference.
    const photoDir = 'stuff'
    const photoFiles = fs.existsSync(photoDir) ? fs.readdirSync(photoDir).filter((f) => /\.(jpe?g|png)$/i.test(f)) : []
    if (photoFiles.length) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(photoDir, photoFiles[0])))
      const mime = /\.png$/i.test(photoFiles[0]) ? 'image/png' : 'image/jpeg'
      const photo = await rig.decodeImage(bytes, mime, 384)
      console.log(`  structured sweep on ${photoFiles[0]} (${photo.width}x${photo.height})`)

      const structSweep = async (build: (s: number) => PassSpec[]) => {
        const frames: Rgba8[] = []
        for (const s of sigmas) {
          frames.push(await rig.capture({ backend: B, width: photo.width, height: photo.height, input: photo, passes: build(s) }))
        }
        const deltas: number[] = []
        for (let i = 1; i < frames.length; i++) deltas.push(meanAbs(frames[i - 1], frames[i]))
        const spike = sweepSpike(deltas)
        const med = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]
        return { spike, atSigma: spike.index >= 0 ? sigmas[spike.index + 1] : NaN, median: med, deltas, frames }
      }

      const sN = await structSweep(naive)
      const sC = await structSweep(compensated)
      const thresholdIdx = (t: number) => Math.max(0, sigmas.findIndex((s) => s >= t) - 1)
      report.structuredSweep = {
        naive: {
          median_delta_codes: +sN.median.toFixed(3),
          worst_spike: +sN.spike.ratio.toFixed(2), at_sigma: sN.atSigma,
          delta_at_sigma16: +sN.deltas[thresholdIdx(16)].toFixed(3),
          delta_at_sigma32: +sN.deltas[thresholdIdx(32)].toFixed(3),
        },
        compensated: {
          median_delta_codes: +sC.median.toFixed(3),
          worst_spike: +sC.spike.ratio.toFixed(2), at_sigma: sC.atSigma,
          delta_at_sigma16: +sC.deltas[thresholdIdx(16)].toFixed(3),
          delta_at_sigma32: +sC.deltas[thresholdIdx(32)].toFixed(3),
        },
      }
      console.log(`    naive:       median delta ${sN.median.toFixed(3)}, worst spike ${sN.spike.ratio.toFixed(2)}x at sigma ${sN.atSigma}, at thresholds 16/32: ${sN.deltas[thresholdIdx(16)].toFixed(3)}/${sN.deltas[thresholdIdx(32)].toFixed(3)}`)
      console.log(`    compensated: median delta ${sC.median.toFixed(3)}, worst spike ${sC.spike.ratio.toFixed(2)}x at sigma ${sC.atSigma}, at thresholds 16/32: ${sC.deltas[thresholdIdx(16)].toFixed(3)}/${sC.deltas[thresholdIdx(32)].toFixed(3)}`)
      const i32p = sigmas.findIndex((s) => s >= 32)
      save('photo-naive-sigma31_5', sN.frames[i32p - 1])
      save('photo-naive-sigma32_0', sN.frames[i32p])
      save('photo-compensated-sigma31_5', sC.frames[i32p - 1])
      save('photo-compensated-sigma32_0', sC.frames[i32p])
    }

    // keep the image-space check too, for the record
    const frameAt = async (build: (s: number) => PassSpec[], s: number) =>
      await rig.capture({ backend: B, width: SIZE, height: SIZE, input: src, passes: build(s) })
    const before31 = await frameAt(naive, 31.5)
    const before32 = await frameAt(naive, 32)
    const after31 = await frameAt(compensated, 31.5)
    const after32 = await frameAt(compensated, 32)
    report.imageSpaceDeltaAtThreshold = {
      naive_codes: +meanAbs(before31, before32).toFixed(3),
      compensated_codes: +meanAbs(after31, after32).toFixed(3),
      note: 'mean-abs on blurred noise: tiny for both because the image is already near-flat',
    }
    save('naive-sigma31_5', before31)
    save('naive-sigma32_0', before32)
    save('compensated-sigma31_5', after31)
    save('compensated-sigma32_0', after32)

  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase5b.json'), JSON.stringify(report, null, 2))
  console.log('\n' + JSON.stringify(report.widthSweep, null, 2))
  console.log(`wrote ${path.join(OUT_DIR, 'phase5b.json')}`)
}

main()
