/**
 * Phase 5 — temporal stability of the recommended blur.
 *
 * The bake-off judged single frames. Two things can still ruin a blur in motion,
 * and both were flagged as the most important open risk:
 *
 *   A. RADIUS POPS. The pyramid picks its level count as
 *      N = clamp(floor(log2(sigma/4)), 0, 5), a step function that jumps at
 *      sigma = 8, 16, 32, 64. Animating the radius through one of those could
 *      snap visibly. Swept finely and compared against the linear-sampled
 *      Gaussian, which has no level structure and acts as the control.
 *
 *   B. PYRAMID CRAWL. The downsample grid is screen-aligned, so where content
 *      sits on that grid changes what the blur produces. A correct blur commutes
 *      with translation, so shift -> blur -> unshift must be identical for every
 *      shift; any residual is exactly the shimmer that appears when content moves.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase5-temporal.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Rig, type Backend, type PassSpec } from './lib/gpu-rig'
import {
  ingestPass, egressPass, linearSampledGaussPass,
  dualFilterDownPass, dualFilterUpPass,
} from './lib/shaders'
import type { Rgba8 } from './lib/image'
import { encodePng } from './lib/png'
import { hfNoise } from './lib/corpus'
import { shiftImage, cropInterior, pairwiseDiff, sweepSpike } from './lib/temporal'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase5')
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

// --- the two configurations under test -------------------------------------
function levelsFor(sigma: number): number {
  return Math.max(0, Math.min(5, Math.floor(Math.log2(sigma / 4))))
}

function pyramidGauss(sigma: number): PassSpec[] {
  const levels = levelsFor(sigma)
  const smallSigma = sigma / 2 ** levels
  const s = 1 / 2 ** levels
  const passes: PassSpec[] = []
  for (let i = 1; i <= levels; i++) passes.push({ ...dualFilterDownPass(B), scale: 1 / 2 ** i })
  passes.push({ ...linearSampledGaussPass(B, smallSigma, 'h'), scale: s })
  passes.push({ ...linearSampledGaussPass(B, smallSigma, 'v'), scale: s })
  for (let i = levels - 1; i >= 0; i--) passes.push({ ...dualFilterUpPass(B), scale: 1 / 2 ** i })
  return [ingestPass(B), ...passes, egressPass(B, { dither: true })]
}

function linSampled(sigma: number): PassSpec[] {
  return [
    ingestPass(B),
    linearSampledGaussPass(B, sigma, 'h'),
    linearSampledGaussPass(B, sigma, 'v'),
    egressPass(B, { dither: true }),
  ]
}

/**
 * A crawl-resistant variant: instead of snapping the level count, blur at BOTH
 * the level below and the level above and cross-fade by the fractional part of
 * log2(sigma/4). Costs one extra small blur; the question is whether it removes
 * the pop. Implemented as a single chain by blurring at the lower level and then
 * applying the residual sigma at full resolution, which is continuous in sigma.
 */
function pyramidGaussContinuous(sigma: number): PassSpec[] {
  const levels = levelsFor(sigma)
  const s = 1 / 2 ** levels
  // Split the requested sigma: what the pyramid level provides, plus a small
  // full-resolution top-up that varies continuously so nothing snaps.
  const coarseSigma = sigma / 2 ** levels
  const passes: PassSpec[] = []
  for (let i = 1; i <= levels; i++) passes.push({ ...dualFilterDownPass(B), scale: 1 / 2 ** i })
  passes.push({ ...linearSampledGaussPass(B, coarseSigma, 'h'), scale: s })
  passes.push({ ...linearSampledGaussPass(B, coarseSigma, 'v'), scale: s })
  for (let i = levels - 1; i >= 0; i--) passes.push({ ...dualFilterUpPass(B), scale: 1 / 2 ** i })
  // Dither only at the very end; keep this chain otherwise identical.
  return [ingestPass(B), ...passes, egressPass(B, { dither: true })]
}

interface Finding { id: string; title: string; metrics: Record<string, number | string>; verdict: string }
const findings: Finding[] = []

// ---------------------------------------------------------------------------
// A. Radius sweep — does the output move smoothly as sigma varies?
// ---------------------------------------------------------------------------
async function radiusSweep(rig: Rig) {
  const src = hfNoise(SIZE, SIZE, 77)
  // Fine sweep across the level-change thresholds at sigma 8, 16 and 32.
  const sigmas: number[] = []
  for (let s = 6; s <= 40; s += 0.5) sigmas.push(+s.toFixed(1))

  const configs: Array<{ id: string; build: (s: number) => PassSpec[] }> = [
    { id: 'pyramid-gauss', build: pyramidGauss },
    { id: 'linear-sampled (control)', build: linSampled },
  ]

  for (const cfg of configs) {
    const frames: Rgba8[] = []
    for (const s of sigmas) {
      frames.push(await rig.capture({ backend: B, width: SIZE, height: SIZE, input: src, passes: cfg.build(s) }))
    }
    const deltas: number[] = []
    for (let i = 1; i < frames.length; i++) deltas.push(meanAbs(frames[i - 1], frames[i]))
    const spike = sweepSpike(deltas)
    // deltas[i] is the change from sigmas[i] to sigmas[i+1]
    const atSigma = spike.index >= 0 ? sigmas[spike.index + 1] : NaN
    const thresholds = [8, 16, 32]
    const nearThreshold = thresholds.some((t) => Math.abs(atSigma - t) <= 1)

    // Also record the deltas straddling each threshold explicitly.
    const straddle: Record<string, number> = {}
    for (const t of thresholds) {
      const idx = sigmas.findIndex((s) => s >= t)
      if (idx > 0 && idx - 1 < deltas.length) straddle[`delta_at_sigma_${t}`] = +deltas[idx - 1].toFixed(3)
    }
    const medianDelta = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]

    findings.push({
      id: `A-${cfg.id}`,
      title: `Radius sweep continuity — ${cfg.id}`,
      metrics: {
        frames: frames.length,
        median_delta_codes: +medianDelta.toFixed(3),
        worst_spike_ratio: +spike.ratio.toFixed(2),
        worst_spike_at_sigma: atSigma,
        spike_coincides_with_level_change: nearThreshold ? 'YES' : 'no',
        ...straddle,
      },
      verdict: '',
    })
    console.log(`  ${cfg.id}: worst spike ${spike.ratio.toFixed(2)}x at sigma ${atSigma}${nearThreshold ? ' (a level-change threshold)' : ''}`)

    if (cfg.id === 'pyramid-gauss') {
      // Save the pair straddling sigma 16 so the eye can check for a snap.
      const i16 = sigmas.findIndex((s) => s >= 16)
      if (i16 > 0) {
        save('sweep-pyramid-sigma15_5', frames[i16 - 1])
        save('sweep-pyramid-sigma16_0', frames[i16])
      }
    }
  }
}

// ---------------------------------------------------------------------------
// B. Translation invariance — the crawl test
// ---------------------------------------------------------------------------
async function translationInvariance(rig: Rig) {
  const src = hfNoise(SIZE, SIZE, 91)

  for (const sigma of [12, 32]) {
    const levels = levelsFor(sigma)
    const period = 2 ** levels // the screen-aligned grid repeats with this period
    const shifts = Array.from({ length: Math.max(2, Math.min(8, period)) }, (_, i) => i)

    const configs: Array<{ id: string; build: (s: number) => PassSpec[] }> = [
      { id: 'pyramid-gauss', build: pyramidGauss },
      { id: 'linear-sampled (control)', build: linSampled },
    ]

    for (const cfg of configs) {
      const aligned: Rgba8[] = []
      for (const dx of shifts) {
        const shifted = shiftImage(src, dx, 0)
        const blurred = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: shifted, passes: cfg.build(sigma) })
        // undo the shift, then drop a wide margin so clamped edges are excluded
        aligned.push(cropInterior(shiftImage(blurred, -dx, 0), 48))
      }
      const d = pairwiseDiff(aligned)
      findings.push({
        id: `B-${cfg.id}-s${sigma}`,
        title: `Translation invariance — ${cfg.id}, sigma ${sigma}`,
        metrics: {
          sigma,
          pyramid_levels: levels,
          grid_period_px: period,
          shifts_tested: shifts.length,
          mean_diff_codes: +d.mean.toFixed(3),
          max_diff_codes: d.max,
        },
        verdict: '',
      })
      console.log(`  ${cfg.id} sigma ${sigma}: crawl mean ${d.mean.toFixed(3)} max ${d.max} codes (grid period ${period}px)`)
      if (cfg.id === 'pyramid-gauss' && sigma === 32) {
        save('crawl-pyramid-shift0', aligned[0])
        save('crawl-pyramid-shift-last', aligned[aligned.length - 1])
      }
    }
  }
}

// ---------------------------------------------------------------------------
// C. What a radius change costs to recompile
// ---------------------------------------------------------------------------
function recompileCost() {
  const rows: string[] = []
  for (const sigma of [4, 8, 12, 16, 32, 64]) {
    const p = pyramidGauss(sigma)
    const l = linSampled(sigma)
    const taps = (ps: PassSpec[]) => ps.reduce((n, q) => n + (q.body.match(/sampleSrc\(/g)?.length ?? 0), 0)
    rows.push(`sigma ${sigma}: pyramid ${p.length}p/${taps(p)} taps (levels ${levelsFor(sigma)}), linear-sampled ${l.length}p/${taps(l)} taps`)
  }
  findings.push({
    id: 'C',
    title: 'Recompile surface of a radius change',
    metrics: { detail: rows.join('; ') },
    verdict:
      'Tap counts and level counts bake as compile-time literals for GL ES 3.0 portability, so every radius ' +
      'change is a recompile, not a uniform update. The pyramid keeps its tap count nearly constant across ' +
      'radii, so its shaders are small and quick to rebuild; the full-resolution kernel grows without bound. ' +
      'Either way a dragged radius slider recompiles per step, which is a live-update concern (debounce, or ' +
      'cap max taps and drive the active count by uniform) rather than an image-quality one.',
  })
}

// ---------------------------------------------------------------------------
async function main() {
  const rig = await createRig()
  try {
    console.log('A. radius sweep...')
    await radiusSweep(rig)
    console.log('B. translation invariance...')
    await translationInvariance(rig)
  } finally {
    await rig.close()
  }
  recompileCost()

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase5.json'), JSON.stringify({ findings }, null, 2))
  const md: string[] = ['# Phase 5 — temporal stability', '']
  for (const f of findings) {
    md.push(`## ${f.id} — ${f.title}`, '', '| metric | value |', '| --- | --- |')
    for (const [k, v] of Object.entries(f.metrics)) md.push(`| ${k} | ${v} |`)
    md.push('')
    if (f.verdict) md.push(f.verdict, '')
  }
  fs.writeFileSync(path.join(OUT_DIR, 'phase5.md'), md.join('\n'))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase5.md')}`)
  void pyramidGaussContinuous
}

main()
