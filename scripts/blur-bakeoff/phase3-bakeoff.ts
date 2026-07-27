/**
 * Phase 3 — the bake-off.
 *
 * Candidates are compared at MATCHED effective blur width, which is the only way
 * the comparison means anything: a Gaussian is parameterized by sigma but Kawase
 * and the dual filter are parameterized by pass count, so each candidate is first
 * calibrated, then judged against a true Gaussian of the width it actually
 * achieved.
 *
 * Effective width is measured from the 10-90% rise of a blurred step edge
 * (= 2.563 sigma for a Gaussian). That is robust on an 8-bit readback, unlike an
 * impulse response, whose peak falls to ~1/(2*pi*sigma^2) and quantizes to zero
 * at any interesting radius.
 *
 * Flawlessness is a GATE: detector screens run first and anything with a visible
 * flaw is eliminated before cost is even reported.
 *
 * Output: reports/blur-bakeoff/phase3.{json,md} + proof images.
 * Run: npx tsx scripts/blur-bakeoff/phase3-bakeoff.ts [--quick]
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Rig, type Backend, type PassSpec } from './lib/gpu-rig'
import {
  ingestPass, egressPass, gaussKernelPass, linearSampledGaussPass,
  boxKernelPass, kawasePass, dualFilterDownPass, dualFilterUpPass,
} from './lib/shaders'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './lib/image'
import { srgbToLinear } from './lib/color'
import { gaussianBlur } from './lib/reference'
import { bandingScore, ringingScore } from './lib/detectors'
import { encodePng } from './lib/png'
import { stepEdge, smoothGradient, transparentEdgeSprite, hfNoise } from './lib/corpus'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase3')
const BACKEND: Backend = 'webgpu'
/**
 * Canvas size scales with the radius. At sigma 64 on a 256px canvas the kernel
 * support (4 sigma) spans the whole frame, so clamp-to-edge dominates every
 * measurement and the 10-90 rise is clipped by the border — which made even the
 * known-good control look flawed. Keeping the frame at ~12 sigma leaves the
 * kernel comfortably inside it.
 */
function sizeFor(sigma: number): number {
  return Math.min(1024, Math.max(256, Math.ceil((sigma * 12) / 64) * 64))
}
const QUICK = process.argv.includes('--quick')
const TARGET_SIGMAS = QUICK ? [8, 32] : [4, 12, 32, 64]
/** Above this, an unrolled full-res kernel stops being buildable/sane. */
const TAP_BUDGET = 1400

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMG_DIR, `${name}.png`), encodePng(img))
}

function countTaps(passes: PassSpec[]): number {
  return passes.reduce((n, p) => n + (p.body.match(/sampleSrc\(/g)?.length ?? 0), 0)
}
/** Sampling work relative to one full-res tap, accounting for per-pass scale. */
function sampleCost(passes: PassSpec[]): number {
  return passes.reduce((n, p) => {
    const taps = p.body.match(/sampleSrc\(/g)?.length ?? 0
    const s = p.scale ?? 1
    return n + taps * s * s
  }, 0)
}

// ---------------------------------------------------------------------------
// Candidate definitions. Each maps a "strength" knob to a pass list, wrapped in
// the shared ingest/egress bracket (linear light + premultiplied alpha).
// ---------------------------------------------------------------------------
interface Candidate {
  id: string
  name: string
  /** Continuous or discrete knob; searched to match the target width. */
  knobs(target: number): number[]
  build(knob: number): PassSpec[]
  /** Requires per-pass resolution scaling, which the engine cannot express yet. */
  needsDownscale?: boolean
  notes: string
}

const B = BACKEND
/**
 * Every candidate gets the same best-practice bracket. Dither is ON for all of
 * them: Phase 2 established it is the fix for banding and costs one hash per
 * pixel, so leaving it off would only let a solved problem mask the differences
 * that actually distinguish these algorithms.
 */
const bracket = (kernels: PassSpec[]): PassSpec[] => [
  ingestPass(B),
  ...kernels,
  egressPass(B, { dither: true }),
]

const CANDIDATES: Candidate[] = [
  {
    id: 'gauss-fullres',
    name: 'Separable Gaussian, full resolution',
    knobs: (t) => [t],
    build: (sigma) => bracket([gaussKernelPass(B, sigma, 'h'), gaussKernelPass(B, sigma, 'v')]),
    notes: 'Reference-quality shape; cost grows linearly with radius.',
  },
  {
    id: 'gauss-linsampled',
    name: 'Separable Gaussian, linear-sampled tap pairs',
    knobs: (t) => [t],
    build: (sigma) => bracket([linearSampledGaussPass(B, sigma, 'h'), linearSampledGaussPass(B, sigma, 'v')]),
    notes: 'Folds tap pairs into one bilinear fetch; ~half the reads.',
  },
  {
    id: 'box3',
    name: 'Box x3 (central limit theorem)',
    knobs: (t) => {
      // three rounds of a (2r+1) box give sigma ~= sqrt(r(r+1)); invert for r
      const r = Math.max(1, Math.round(Math.sqrt(t * t + 0.25) - 0.5))
      return [r - 1, r, r + 1].filter((v) => v >= 1)
    },
    build: (r) =>
      bracket([
        boxKernelPass(B, r, 'h'), boxKernelPass(B, r, 'v'),
        boxKernelPass(B, r, 'h'), boxKernelPass(B, r, 'v'),
        boxKernelPass(B, r, 'h'), boxKernelPass(B, r, 'v'),
      ]),
    notes: 'Six cheap passes; shape converges toward Gaussian but stays slightly boxy.',
  },
  {
    id: 'kawase',
    name: 'Kawase (5 passes, offsets scaled to radius)',
    // A fixed offset sequence tops out around sigma 9, so the knob scales the
    // offsets instead. Stretching taps apart is how Kawase reaches a wide radius
    // cheaply — and is exactly what is expected to introduce grid structure.
    knobs: () => [0.5, 1, 1.5, 2, 3, 4, 6, 8, 11, 15, 20, 26],
    build: (scale) => {
      const seq = [0, 1, 2, 2, 3]
      return bracket(seq.map((o) => kawasePass(B, (o + 0.5) * scale - 0.5)))
    },
    notes: 'Four bilinear fetches per pass, five passes at any radius; no downscale needed.',
  },
  {
    id: 'dual-filter',
    name: 'Dual filter / dual Kawase (Bjorge pyramid)',
    knobs: () => [1, 2, 3, 4, 5, 6, 7],
    build: (levels) => {
      const passes: PassSpec[] = []
      for (let i = 1; i <= levels; i++) passes.push({ ...dualFilterDownPass(B), scale: 1 / 2 ** i })
      for (let i = levels - 1; i >= 0; i--) passes.push({ ...dualFilterUpPass(B), scale: 1 / 2 ** i })
      return bracket(passes)
    },
    needsDownscale: true,
    notes: 'Halving pyramid down then up; cost is nearly independent of radius.',
  },
  {
    id: 'pyramid-gauss',
    name: 'Radius-adaptive pyramid Gaussian (progressive halving + linear-sampled)',
    // The fixed quarter-res variant below loses detail at small radii because it
    // drops the small-resolution sigma to ~2px, too little to resample safely.
    // Here the number of halvings is chosen so the small-res sigma stays in a
    // safe band (~3-6px) whatever the radius, halving progressively (each step a
    // dual-filter-style 5-tap box) rather than resampling in one aliasing jump.
    knobs: (t) => [t],
    build: (sigma) => {
      const TARGET_SMALL = 4
      const levels = Math.max(0, Math.min(5, Math.floor(Math.log2(sigma / TARGET_SMALL))))
      const smallSigma = sigma / 2 ** levels
      const passes: PassSpec[] = []
      for (let i = 1; i <= levels; i++) passes.push({ ...dualFilterDownPass(B), scale: 1 / 2 ** i })
      const s = 1 / 2 ** levels
      passes.push({ ...linearSampledGaussPass(B, smallSigma, 'h'), scale: s })
      passes.push({ ...linearSampledGaussPass(B, smallSigma, 'v'), scale: s })
      for (let i = levels - 1; i >= 0; i--) passes.push({ ...dualFilterUpPass(B), scale: 1 / 2 ** i })
      return bracket(passes)
    },
    needsDownscale: true,
    notes: 'Gaussian shape with cost nearly independent of radius; needs per-pass resolution.',
  },
  {
    id: 'downscaled-gauss',
    name: 'Downscaled separable Gaussian (fixed quarter res)',
    knobs: (t) => [t],
    build: (sigma) => {
      const s = 0.25
      return bracket([
        { body: 'return sampleSrc(uv);', filter: 'linear', scale: s },
        { ...gaussKernelPass(B, sigma * s, 'h'), scale: s },
        { ...gaussKernelPass(B, sigma * s, 'v'), scale: s },
        { body: 'return sampleSrc(uv);', filter: 'linear', scale: 1 },
      ])
    },
    needsDownscale: true,
    notes: 'Gaussian shape at a fraction of the sampling work; needs per-pass resolution.',
  },
]

// ---------------------------------------------------------------------------
// Effective-width measurement: 10-90% rise of a blurred step edge.
// ---------------------------------------------------------------------------
async function measureSigma(rig: Rig, passes: PassSpec[], size: number): Promise<number> {
  const out = await rig.capture({ backend: B, width: size, height: 32, input: stepEdge(size, 32), passes })
  const row = 16
  // The profile MUST be read in linear light. sRGB encoding stretches the darks,
  // which pushes the 10% crossing outward and inflates the measured width by
  // ~1.23x — enough to build the comparison reference at the wrong sigma and
  // manufacture an "edge shape error" for an otherwise exact Gaussian.
  const prof: number[] = []
  for (let x = 0; x < out.width; x++) prof.push(srgbToLinear(out.data[(row * out.width + x) * 4] / 255))
  // Use an interior window so clamp-to-edge behaviour at the borders is excluded.
  const lo = Math.min(...prof)
  const hi = Math.max(...prof)
  if (hi - lo < 0.05) return NaN
  const t10 = lo + 0.1 * (hi - lo)
  const t90 = lo + 0.9 * (hi - lo)
  const cross = (target: number): number => {
    for (let x = 1; x < prof.length; x++) {
      if ((prof[x - 1] < target && prof[x] >= target) || (prof[x - 1] > target && prof[x] <= target)) {
        const d = prof[x] - prof[x - 1]
        return d === 0 ? x : x - 1 + (target - prof[x - 1]) / d
      }
    }
    return NaN
  }
  const x10 = cross(t10)
  const x90 = cross(t90)
  if (!Number.isFinite(x10) || !Number.isFinite(x90)) return NaN
  return Math.abs(x90 - x10) / 2.563 // Gaussian CDF 10-90 width
}

// ---------------------------------------------------------------------------
interface Result {
  candidate: string
  targetSigma: number
  achievedSigma: number
  knob: number
  passes: number
  taps: number
  sampleCost: number
  needsDownscale: boolean
  metrics: Record<string, number>
  flaws: string[]
  eliminated: boolean
  skipped?: string
}

const results: Result[] = []

interface Stimuli { edge: Rgba8; gradient: Rgba8; sprite: Rgba8; noise: Rgba8 }
const stimuliCache = new Map<number, Stimuli>()
function stimuliFor(size: number): Stimuli {
  const hit = stimuliCache.get(size)
  if (hit) return hit
  const s: Stimuli = {
    edge: stepEdge(size, size),
    gradient: smoothGradient(size, size, { from: 96, to: 132 }),
    sprite: transparentEdgeSprite(size, size),
    noise: hfNoise(size, size, 5),
  }
  stimuliCache.set(size, s)
  return s
}

function meanAbs(a: Rgba8, b: Rgba8): number {
  let s = 0
  let n = 0
  for (let p = 0; p < a.width * a.height; p++)
    for (let c = 0; c < 3; c++) { s += Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); n++ }
  return s / n
}
function maxAbs(a: Rgba8, b: Rgba8): number {
  let m = 0
  for (let p = 0; p < a.width * a.height; p++)
    for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); if (d > m) m = d }
  return m
}
/** Green dragged out of the transparent field = invented colour at alpha edges. */
function greenLeak(img: Rgba8): number {
  let worst = 0
  for (let p = 0; p < img.width * img.height; p++) {
    if (img.data[p * 4 + 3] < 200) continue
    const leak = img.data[p * 4 + 1] - Math.max(img.data[p * 4] * 0.35, 40)
    if (leak > worst) worst = leak
  }
  return worst
}

async function evaluate(rig: Rig, cand: Candidate, target: number): Promise<void> {
  const SIZE = sizeFor(target)
  const STIMULI = stimuliFor(SIZE)
  // --- calibrate: pick the knob whose measured width is closest to target ---
  let best: { knob: number; sigma: number; passes: PassSpec[] } | null = null
  for (const knob of cand.knobs(target)) {
    const passes = cand.build(knob)
    if (countTaps(passes) > TAP_BUDGET) continue
    const sigma = await measureSigma(rig, passes, SIZE)
    if (!Number.isFinite(sigma)) continue
    if (!best || Math.abs(sigma - target) < Math.abs(best.sigma - target)) best = { knob, sigma, passes }
  }

  if (!best) {
    results.push({
      candidate: cand.id, targetSigma: target, achievedSigma: NaN, knob: NaN,
      passes: NaN, taps: NaN, sampleCost: NaN, needsDownscale: !!cand.needsDownscale,
      metrics: {}, flaws: [], eliminated: true,
      skipped: `no configuration within the ${TAP_BUDGET}-tap budget could reach sigma ${target}`,
    })
    return
  }

  const { knob, sigma, passes } = best
  // Judge against a true Gaussian of the width this candidate ACTUALLY achieved.
  const refFor = (src: Rgba8) => encodeToSrgb8(gaussianBlur(decodeToLinear(src), sigma, { premultiplied: true }))

  const metrics: Record<string, number> = {}
  const flaws: string[] = []

  // shape / ringing on a hard edge
  const edgeOut = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: STIMULI.edge, passes })
  const edgeRef = refFor(STIMULI.edge)
  metrics.edge_mean_err = +meanAbs(edgeOut, edgeRef).toFixed(2)
  metrics.edge_max_err = maxAbs(edgeOut, edgeRef)
  metrics.ringing = +ringingScore(decodeToLinear(edgeOut), decodeToLinear(STIMULI.edge)).toFixed(4)

  // banding on a low-contrast ramp. A 36-code ramp across 256px already has
  // ~7px plateaus before any blur, so an absolute threshold would condemn every
  // candidate including the control. Judge against what the ideal Gaussian scores
  // on the same stimulus instead.
  const gradOut = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: STIMULI.gradient, passes })
  const gradRef = refFor(STIMULI.gradient)
  metrics.banding = +bandingScore(gradOut).toFixed(2)
  metrics.banding_reference = +bandingScore(gradRef).toFixed(2)
  metrics.gradient_mean_err = +meanAbs(gradOut, gradRef).toFixed(2)

  // alpha fringing
  const spriteOut = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: STIMULI.sprite, passes })
  metrics.green_leak = +greenLeak(spriteOut).toFixed(1)

  // detail / high frequency
  const noiseOut = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: STIMULI.noise, passes })
  metrics.noise_mean_err = +meanAbs(noiseOut, refFor(STIMULI.noise)).toFixed(2)

  // --- flawlessness gate (screens run BEFORE cost is considered) ---
  // Thresholds are stated against the matched ideal Gaussian, and are calibrated
  // so the known-good control (gauss-fullres) passes: a candidate is flawed when
  // it deviates from the ideal by more than 8-bit rounding can explain.
  if (metrics.ringing > 0.02) flaws.push(`ringing ${metrics.ringing}`)
  if (metrics.green_leak > 6) flaws.push(`alpha fringing ${metrics.green_leak}/255`)
  if (metrics.edge_mean_err > 2) flaws.push(`edge shape ${metrics.edge_mean_err} codes off ideal`)
  if (metrics.edge_max_err > 16) flaws.push(`edge worst-case ${metrics.edge_max_err} codes off ideal`)
  if (metrics.noise_mean_err > 2) flaws.push(`detail ${metrics.noise_mean_err} codes off ideal`)
  if (metrics.banding > metrics.banding_reference * 1.25 + 1)
    flaws.push(`banding ${metrics.banding} vs ideal ${metrics.banding_reference}`)

  if (target === TARGET_SIGMAS[TARGET_SIGMAS.length - 1]) {
    save(`${cand.id}-edge-s${Math.round(sigma)}`, edgeOut)
    save(`${cand.id}-noise-s${Math.round(sigma)}`, noiseOut)
    save(`${cand.id}-sprite-s${Math.round(sigma)}`, spriteOut)
  }

  results.push({
    candidate: cand.id, targetSigma: target, achievedSigma: +sigma.toFixed(2), knob,
    passes: passes.length, taps: countTaps(passes), sampleCost: +sampleCost(passes).toFixed(1),
    needsDownscale: !!cand.needsDownscale, metrics, flaws, eliminated: flaws.length > 0,
  })
}

async function main() {
  const rig = await createRig()
  if (!rig.available.webgpu) { console.error('WebGPU unavailable'); await rig.close(); process.exit(1) }
  try {
    for (const target of TARGET_SIGMAS) {
      for (const cand of CANDIDATES) {
        process.stdout.write(`  sigma ${target} — ${cand.id} ... `)
        await evaluate(rig, cand, target)
        const r = results[results.length - 1]
        console.log(r.skipped ? `SKIPPED (${r.skipped})` : `${r.eliminated ? 'FLAWED' : 'clean'} (achieved ${r.achievedSigma}, ${r.passes}p, cost ${r.sampleCost})`)
      }
    }
    // reference plates for the eye, at the widest radius
    const widest = TARGET_SIGMAS[TARGET_SIGMAS.length - 1]
    const st = stimuliFor(sizeFor(widest))
    save('_reference-edge', encodeToSrgb8(gaussianBlur(decodeToLinear(st.edge), widest, { premultiplied: true })))
    save('_reference-noise', encodeToSrgb8(gaussianBlur(decodeToLinear(st.noise), widest, { premultiplied: true })))
    save('_reference-sprite', encodeToSrgb8(gaussianBlur(decodeToLinear(st.sprite), widest, { premultiplied: true })))
    save('_source-noise', st.noise)
  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUT_DIR, 'phase3.json'),
    JSON.stringify({ backend: BACKEND, sizes: TARGET_SIGMAS.map((s) => ({ sigma: s, size: sizeFor(s) })), results }, null, 2),
  )

  const md: string[] = [
    '# Phase 3 — candidate bake-off',
    '',
    `Backend \`${BACKEND}\`. Canvas scales with radius (~12 sigma) so the kernel stays`,
    'inside the frame. Every candidate runs inside the same',
    'ingest/egress bracket (linear light, premultiplied alpha) established in Phase 2,',
    'and is calibrated so its measured 10-90% edge rise matches the target width —',
    'then judged against a true Gaussian of the width it actually achieved.',
    '',
    'Flawlessness is a gate: a candidate with a detected flaw is eliminated before',
    'cost is weighed. `cost` is sampling work relative to one full-resolution tap.',
    '',
  ]
  for (const target of TARGET_SIGMAS) {
    md.push(`## Target sigma ${target} (canvas ${sizeFor(target)}px)`, '')
    md.push('| candidate | achieved σ | passes | taps | cost | edge err (mean/max) | ringing | banding (vs ideal) | leak | detail err | verdict |')
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const r of results.filter((x) => x.targetSigma === target)) {
      if (r.skipped) { md.push(`| ${r.candidate} | — | — | — | — | — | — | — | — | — | skipped: ${r.skipped} |`); continue }
      const m = r.metrics
      md.push(
        `| ${r.candidate} | ${r.achievedSigma} | ${r.passes} | ${r.taps} | ${r.sampleCost} | ` +
        `${m.edge_mean_err} / ${m.edge_max_err} | ${m.ringing} | ${m.banding} (${m.banding_reference}) | ` +
        `${m.green_leak} | ${m.noise_mean_err} | ` +
        `${r.eliminated ? '**FLAWED**: ' + r.flaws.join('; ') : 'clean'} |`,
      )
    }
    md.push('')
  }
  fs.writeFileSync(path.join(OUT_DIR, 'phase3.md'), md.join('\n'))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase3.md')}`)
}

main()
