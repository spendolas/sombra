/**
 * Phase 9b — the frost bake-off.
 *
 * Decides what replaces the 8-tap white-hash square-footprint gather in
 * src/nodes/transform/reeded-glass.ts. Nothing here ships; this phase measures.
 *
 * Two modes:
 *
 *   npx tsx scripts/blur-bakeoff/phase9-frost.ts            (default, --validate)
 *       Proves the BENCH is trustworthy before any candidate is ranked:
 *         A  every metric scored on a synthetic known-good AND known-bad, plus a
 *            degenerate input, with the chosen threshold printed next to both.
 *         B  the kernel-shape metrics scored on five ANALYTIC point-spread
 *            functions whose answers are known in closed form.
 *         C  GPU trust: every candidate compiles and renders live on BOTH
 *            backends; the WGSL uniformity rule is actively exercised (with a
 *            positive control that MUST fail to compile); the WebGL2 pass-0
 *            linear-filter bug is proven absent from this pass chain; the
 *            256-tap GPU ground truth is checked against the CPU converged disc
 *            (with a negative control that must FAIL that same check).
 *         D  re-roll and cost metrics scored for monotonicity in tap count.
 *
 *   npx tsx scripts/blur-bakeoff/phase9-frost.ts --sweep [--quick]
 *       The full matrix: candidate x frost x DPR x backend x stimulus.
 *       21 candidates x 5 frost x 2 DPR x 2 backends x 5 stimuli, plus re-roll,
 *       the DPR-tier flip and the point-spread measurement: ~3000 GPU captures.
 *       Budget 25-45 min (measured: 0.23 s per 512x512 capture on WebGPU;
 *       WebGL2 is slower because gpu-rig recompiles every program per capture).
 *       --quick runs one backend / one DPR / one frost / two stimuli in ~50 s
 *       and writes phase9-quick.* — it exercises the whole code path without
 *       pretending a partial run is the bake-off.
 *
 * Geometry, from the node:
 *   half-extent = frost * 24 * u_dpr DEVICE px   (frost is 0..1)
 *   seed lattice cell = 4 * u_dpr device px = 4 CSS px at every DPR
 * All images here are DEVICE-pixel rasters.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Backend, type Rig, type PassSpec } from './lib/gpu-rig'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './lib/image'
import { encodePng } from './lib/png'
import { transparentEdgeSprite, hfNoise, stepEdge } from './lib/corpus'
import { discBlurFast, sparseTapScatter } from './lib/frost-kernels'
import { deviation, blockEdgeExcess, speckleRms, directionalCorr, insetRoi, type Roi } from './lib/frost-metrics'
import { residualAcf, blockPeriodSpectrum, psfStats, type PsfStats } from './lib/frost-detectors'
import {
  type Candidate,
  captureFrost,
  frostPasses,
  fetchesPerPixel,
  impulseField,
  addNoise,
  forceBlocks,
  resampleBilinear,
} from './lib/frost-bench'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase9')
const IMG_DIR = path.join(OUT_DIR, 'frost')

const SIZE = 512 // device px for the image-quality stimuli
const PSF_SIZE = 768 // device px for the point-spread stimulus
const BACKENDS: Backend[] = ['webgpu', 'webgl2']

// ===========================================================================
// Candidate registry
// ===========================================================================

function sunflower(id: string, taps: number, opts: Partial<Candidate['kernel']> & { note: string; label?: string }): Candidate {
  const { note, label, ...k } = opts
  return {
    id,
    label: label ?? id,
    note,
    kernel: { taps, pattern: 'sunflower', seed: 'pixel', rot: 'hash', weight: 'uniform', ...k },
  }
}

export const CANDIDATES: Candidate[] = [
  {
    id: 'C0',
    label: 'C0 ship 8 sq lattice',
    note: 'EXACTLY what ships: 8 reedHash taps, uniform in a SQUARE, seeded from the 4*u_dpr device-px lattice. The known-bad.',
    kernel: { taps: 8, pattern: 'squareHash', seed: 'lattice' },
  },
  {
    id: 'C1',
    label: 'C1 8 sq per-px',
    note: 'C0 with the lattice removed: seed = floor(gl_FragCoord.xy), an undistorted position the node can reach. Isolates the lattice.',
    kernel: { taps: 8, pattern: 'squareHash', seed: 'pixel' },
  },
  {
    id: 'C2',
    label: 'C2 8 disc per-px',
    note: 'C1 mapped to a uniform disc: r = R*sqrt(u), theta = 2*pi*v. Isolates the footprint shape at identical fetch cost.',
    kernel: { taps: 8, pattern: 'discHash', seed: 'pixel' },
  },
  sunflower('C3-8', 8, { note: 'Vogel/sunflower disc, white-hash per-pixel rotation. Stratified positions at C0 cost.' }),
  sunflower('C3-12', 12, { note: 'Vogel 12.' }),
  sunflower('C3-16', 16, { note: 'Vogel 16 — Sterna 2018 operating point.' }),
  sunflower('C3-24', 24, { note: 'Vogel 24.' }),
  sunflower('C3j-8', 8, { pattern: 'sunflowerJit', note: 'ADDED: Vogel with the radius jittered inside its own annulus, r = R*sqrt((i+u_i)/N). Rotation cannot fill the sqrt(0.5/N)*R hole at the centre or the concentric rings, because rotation preserves radius; radial jitter does.' }),
  sunflower('C3j-16', 16, { pattern: 'sunflowerJit', note: 'ADDED: radially jittered Vogel, 16 taps.' }),
  sunflower('C3j-24', 24, { pattern: 'sunflowerJit', note: 'ADDED: radially jittered Vogel, 24 taps.' }),
  sunflower('C4-16', 16, { weight: 'gauss', gaussK: 2, note: 'C3-16 with a Gaussian radial weight exp(-2 r^2); alpha divided by the measured weight sum, not by N.' }),
  sunflower('C4j-16', 16, { pattern: 'sunflowerJit', weight: 'gauss', gaussK: 2, note: 'C3j-16 with a Gaussian radial weight.' }),
  sunflower('C5-8', 8, { rot: 'ign', note: 'C3-8 with the rotation from interleaved gradient noise instead of a white bit-hash.' }),
  sunflower('C5-16', 16, { rot: 'ign', note: 'C3-16 + IGN rotation.' }),
  sunflower('C5-24', 24, { rot: 'ign', note: 'C3-24 + IGN rotation.' }),
  sunflower('C5j-16', 16, { pattern: 'sunflowerJit', rot: 'ign', note: 'Radially jittered Vogel + IGN rotation.' }),
  sunflower('C5f-16', 16, {
    pattern: 'sunflowerJit',
    rot: 'ignCss',
    seed: 'cssPixel',
    note: 'C5j-16 seeded from CSS pixels (floor(fragCoord/u_dpr)) instead of device pixels: a 1-CSS-px lattice, which the characterisation showed is exactly as DPR/resize invariant as the shipped 4-CSS-px one.',
  }),
  {
    id: 'C6',
    label: 'C6 pyramid + 4',
    note: 'Dual-filter down/up prefilter pyramid then a 4-tap per-pixel disc gather. Cost independent of radius; NOT shippable today (needs node-owned auxiliary passes in the compiler). Priced, not proposed.',
    kernel: { taps: 4, pattern: 'discHash', seed: 'pixel' },
    pyramidDepth: 3,
    radiusScale: 0.6,
  },
  {
    id: 'C7',
    label: 'C7 GROUND TRUTH 256',
    note: 'GROUND TRUTH, not shippable: 256-tap radially jittered stratified disc. Every other candidate is scored against this.',
    kernel: { taps: 256, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash', emit: 'procedural' },
    groundTruth: true,
  },
  {
    id: 'GTsq',
    label: 'GT square 256',
    note: 'Converged version of the SQUARE family (C0/C1), so their estimator noise can be separated from their footprint shape.',
    kernel: { taps: 256, pattern: 'squareHash', seed: 'pixel' },
    groundTruth: true,
  },
  {
    id: 'GTg',
    label: 'GT gauss 256',
    note: 'Converged version of the Gaussian-weighted family (C4).',
    kernel: { taps: 256, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash', weight: 'gauss', gaussK: 2, emit: 'procedural' },
    groundTruth: true,
  },
]

/** Which converged reference isolates a candidate's estimator noise from its shape. */
export function familyRef(c: Candidate): string {
  if (c.kernel.pattern === 'squareHash') return 'GTsq'
  if (c.kernel.weight === 'gauss') return 'GTg'
  return 'C7'
}

// ===========================================================================
// small utilities
// ===========================================================================
const files: string[] = []

function save(dir: string, name: string, img: Rgba8): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${name}.png`)
  fs.writeFileSync(p, encodePng(img))
  files.push(p)
  return p
}

function centerCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const cw = Math.min(w, img.width)
  const ch = Math.min(h, img.height)
  const x0 = Math.floor((img.width - cw) / 2)
  const y0 = Math.floor((img.height - ch) / 2)
  const out: Rgba8 = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      for (let c = 0; c < 4; c++) out.data[(y * cw + x) * 4 + c] = img.data[((y + y0) * img.width + (x + x0)) * 4 + c]
  return out
}

function cropZoom(img: Rgba8, x0: number, y0: number, w: number, h: number, scale: number): Rgba8 {
  const ow = w * scale
  const oh = h * scale
  const out: Rgba8 = { width: ow, height: oh, data: new Uint8ClampedArray(ow * oh * 4) }
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(img.width - 1, x0 + Math.floor(x / scale))
      const sy = Math.min(img.height - 1, y0 + Math.floor(y / scale))
      for (let c = 0; c < 4; c++) out.data[(y * ow + x) * 4 + c] = img.data[(sy * img.width + sx) * 4 + c]
    }
  return out
}

function montage(tiles: Rgba8[], gap = 8): Rgba8 {
  const h = Math.max(...tiles.map((t) => t.height))
  const w = tiles.reduce((s, t) => s + t.width, 0) + gap * (tiles.length - 1)
  const out: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 24
    out.data[i + 1] = 24
    out.data[i + 2] = 32
    out.data[i + 3] = 255
  }
  let ox = 0
  for (const t of tiles) {
    for (let y = 0; y < t.height; y++)
      for (let x = 0; x < t.width; x++)
        for (let c = 0; c < 4; c++) out.data[(y * w + (x + ox)) * 4 + c] = t.data[(y * t.width + x) * 4 + c]
    ox += t.width + gap
  }
  return out
}

const r2 = (v: number) => Math.round(v * 100) / 100
const r3 = (v: number) => Math.round(v * 1000) / 1000
const pad = (v: unknown, n: number) => String(v).padEnd(n)
const padL = (v: unknown, n: number) => String(v).padStart(n)

interface Gate {
  metric: string
  goodLabel: string
  good: number | string
  badLabel: string
  bad: number | string
  threshold: string
  pass: boolean
  note?: string
}

const gates: Gate[] = []
function gate(g: Gate): Gate {
  gates.push(g)
  return g
}

// ===========================================================================
// Stimuli
// ===========================================================================
interface Stim {
  name: string
  img: Rgba8
  note: string
}

async function loadStimuli(rig: Rig): Promise<Stim[]> {
  const out: Stim[] = []
  const photos: Array<[string, string, number, string]> = [
    ['photo-street', 'stuff/2013-03-12 00.48.07.jpg', 1024, 'photograph: mixed fine detail and smooth regions'],
    ['ui-screenshot', 'stuff/Screenshot 2026-06-11 at 15.38.50.png', 0, 'native-res UI: hard high-contrast edges and text — worst case for block artefacts'],
  ]
  for (const [name, file, maxDim, note] of photos) {
    const bytes = new Uint8Array(fs.readFileSync(file))
    const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const dec = await rig.decodeImage(bytes, mime, maxDim || undefined)
    out.push({ name, note, img: centerCrop(dec, SIZE, SIZE) })
  }
  out.push({ name: 'hf-noise', img: hfNoise(SIZE, SIZE, 1337), note: 'white noise: maximal per-tap variance, the speckle stress case' })
  out.push({ name: 'step-edge', img: stepEdge(SIZE, SIZE), note: 'hard C=255 edge: where the estimator noise is maximal (Bernoulli taps)' })
  out.push({ name: 'alpha-sprite', img: transparentEdgeSprite(SIZE, SIZE), note: 'transparent-edge sprite: the premultiplied / alpha-staircase case' })
  return out
}

// ===========================================================================
// A. Metric calibration on CPU synthetics
// ===========================================================================

interface CalibRow {
  image: string
  acf1: number
  acf4: number
  acf8: number
  shoulder: number
  residRms: number
  acfDegenerate: boolean
  domPeriod: number | null
  domAmp: number
  prominence: number
  devMean: number
  devP99: number
  speckleExcess: number
  blockExcess: number
}

function calibrateImageMetrics(baseSrgb: Rgba8, R: number, block: number): { rows: CalibRow[]; conv: Rgba8; bad: Rgba8 } {
  const lin = decodeToLinear(baseSrgb)
  const conv = encodeToSrgb8(discBlurFast(lin, R, { premultiplied: true }))
  const roi = insetRoi(conv.width, conv.height, Math.ceil(1.5 * R) + 8)

  const flatImg = flat(conv.width, conv.height, 128)
  // Each variant carries its OWN reference. A flat image scored against a photo
  // reference is not a degeneracy test, it is a 74-code error with a smooth
  // residual — it would have "passed" the degeneracy guard by accident.
  const variants: Array<[string, Rgba8, Rgba8]> = [
    ['GOOD conv (identical)', conv, conv],
    ['GOOD conv + iid 1 code', addNoise(conv, 1, 7), conv],
    ['GOOD conv + iid 6 codes', addNoise(conv, 6, 11), conv],
    [`BAD  block-quantised ${block}`, forceBlocks(conv, block), conv],
    [`BAD  shipped 8tap lattice ${block}`, encodeToSrgb8(sparseTapScatter(lin, { halfExtentPx: R, taps: 8, seedBlockPx: block })), conv],
    ['BAD  8tap per-pixel (grain, no blocks)', encodeToSrgb8(sparseTapScatter(lin, { halfExtentPx: R, taps: 8, seedBlockPx: 0 })), conv],
    ['DEGEN flat grey vs flat grey', flatImg, flatImg],
  ]

  const rows: CalibRow[] = []
  for (const [image, img, ref] of variants) {
    const a = residualAcf(img, ref, roi, 16)
    const bp = blockPeriodSpectrum(img, roi, 16)
    const d = deviation(img, ref, roi)
    rows.push({
      image,
      acf1: r3(a.acf[0]),
      acf4: r3(a.acf[3]),
      acf8: r3(a.acf[7]),
      shoulder: a.shoulderLag,
      residRms: r2(a.residRms),
      acfDegenerate: a.degenerate,
      domPeriod: bp.dominantPeriod,
      domAmp: r3(bp.dominantAmplitude),
      prominence: r2(bp.prominence),
      devMean: r2(d.meanAbs),
      devP99: d.p99Abs,
      speckleExcess: r2(speckleRms(img, roi) - speckleRms(ref, roi)),
      blockExcess: r2(blockEdgeExcess(img, block, roi).excess),
    })
  }
  return { rows, conv, bad: variants[4][1] }
}

function flat(w: number, h: number, v: number): Rgba8 {
  const img: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let p = 0; p < w * h; p++) {
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v
    img.data[p * 4 + 3] = 255
  }
  return img
}

// ===========================================================================
// B. Kernel-shape calibration on ANALYTIC point-spread functions
// ===========================================================================

type PsfKind = 'disc' | 'square' | 'gauss' | 'annulus' | 'rings8'

/** Build an exact 8-bit linear PSF patch, so psfStats can be checked in closed form. */
function syntheticPsf(kind: PsfKind, R: number, gain: number, dotMass: number, half: number): Rgba8 {
  const n = 2 * half + 1
  const img: Rgba8 = { width: n, height: n, data: new Uint8ClampedArray(n * n * 4) }
  const sig = R / 2
  const r0 = 0.25 * R
  const rings = Array.from({ length: 8 }, (_, i) => Math.sqrt((i + 0.5) / 8) * R)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = x - half
      const dy = y - half
      const r = Math.sqrt(dx * dx + dy * dy)
      let k = 0
      switch (kind) {
        case 'disc':
          k = r <= R ? 1 / (Math.PI * R * R) : 0
          break
        case 'square':
          k = Math.max(Math.abs(dx), Math.abs(dy)) <= R ? 1 / (4 * R * R) : 0
          break
        case 'gauss':
          k = Math.exp(-(r * r) / (2 * sig * sig)) / (2 * Math.PI * sig * sig)
          break
        case 'annulus':
          k = r >= r0 && r <= R ? 1 / (Math.PI * (R * R - r0 * r0)) : 0
          break
        case 'rings8':
          for (const rr of rings) if (Math.abs(r - rr) <= 0.5) k += 1 / 8 / (2 * Math.PI * rr)
          break
      }
      // same sqrt compander the GPU egress applies, so the calibration exercises
      // the exact code path (including its quantisation) that the sweep uses
      const v = Math.min(255, Math.round(Math.sqrt(Math.min(1, k * dotMass * gain)) * 255))
      const i = (y * n + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  return img
}

const PSF_KEYS = ['squareness', 'holeDeficit', 'massOutsideR', 'profileL1Disc', 'profileL1Gauss', 'ringiness', 'clipFraction', 'massCaptured', 'gain'] as const
type PsfKey = (typeof PSF_KEYS)[number]
type PsfCalibRow = Record<PsfKey, number> & { kind: PsfKind }

const PSF_EXTENT = 1.6
const PSF_DOT = 3

/**
 * A PSF measurement is only valid if the linear-gain egress does not saturate:
 * a clipped peak truncates the profile and silently deflates every shape number.
 * Kernel peaks differ hugely (matched Gaussian 2x a disc; a thin sunflower ring
 * far more), so the gain is chosen ADAPTIVELY — capture, look at clipFraction,
 * back off by 4x, repeat. Returns the stats plus the gain that worked.
 */
const PSF_PHASES = [0, 977, 1523, 4099]

async function measurePsfAdaptive(
  take: (gain: number, phase: number) => Promise<Rgba8>,
  centers: Array<[number, number]>,
  R: number,
  dotMass: number,
  phases: number[] = PSF_PHASES,
): Promise<{ stats: PsfStats; gain: number; attempts: number; captures: number; img: Rgba8 }> {
  let gain = (0.5 * Math.PI * R * R) / dotMass
  let probe: Rgba8 | null = null
  let attempts = 0
  for (let attempt = 1; attempt <= 5; attempt++) {
    attempts = attempt
    probe = await take(gain, phases[0])
    if (psfStats([probe], centers, R, gain, dotMass, { extent: PSF_EXTENT }).clipFraction === 0) break
    if (attempt < 5) gain /= 4
  }
  // Gain settled on one phase; now average the remaining phases at that gain to
  // beat down the realisation noise of a lattice-seeded sample set.
  const imgs: Rgba8[] = [probe!]
  for (const ph of phases.slice(1)) imgs.push(await take(gain, ph))
  const stats = psfStats(imgs, centers, R, gain, dotMass, { extent: PSF_EXTENT })
  return { stats, gain, attempts, captures: attempts + phases.length - 1, img: probe! }
}

async function calibratePsf(R: number): Promise<PsfCalibRow[]> {
  const half = Math.ceil(R * PSF_EXTENT) + 2
  const dotMass = PSF_DOT * PSF_DOT
  const out: PsfCalibRow[] = []
  for (const kind of ['disc', 'square', 'gauss', 'annulus', 'rings8'] as PsfKind[]) {
    const { stats: s, gain } = await measurePsfAdaptive(
      async (g) => syntheticPsf(kind, R, g, dotMass, half),
      [[half, half]],
      R,
      dotMass,
      [0], // the analytic PSFs are deterministic; there is no realisation noise to average
    )
    out.push({
      kind,
      squareness: r3(s.squareness),
      holeDeficit: r3(s.holeDeficit),
      massOutsideR: r3(s.massOutsideR),
      profileL1Disc: r3(s.profileL1Disc),
      profileL1Gauss: r3(s.profileL1Gauss),
      ringiness: r3(s.ringiness),
      clipFraction: r3(s.clipFraction),
      massCaptured: r3(s.massCaptured),
      gain: Math.round(gain),
    })
  }
  return out
}

// ===========================================================================
// C. GPU trust checks
// ===========================================================================

/** A pass whose gather sits under a NON-uniform branch but uses textureSample:
 *  WGSL must reject it. If this ever compiles, the uniformity probe is dead. */
function uniformityPositiveControl(): PassSpec {
  return {
    prelude: `fn S0(p: vec2f) -> vec4f { return textureSampleLevel(srcTex, srcSamp, p, 0.0); }`,
    body: `
  var f: f32 = U.u_params.x * min(1.0, S0(uv).a + 1.0);
  var o: vec4f;
  if (f > 0.001) { o = sampleSrc(uv + U.u_texel * 3.0); } else { o = S0(uv); }
  return o;`,
    filter: 'linear',
  }
}

/** Half-texel diagonal offset on a 1-px checker: blends only if LINEAR is live. */
function filterProbePasses(backend: Backend): PassSpec[] {
  const decl = backend === 'webgpu' ? 'var c: vec4 = ' : 'vec4 c = '
  return [
    { body: `${decl}sampleSrc(uv); return c;`, filter: 'nearest' },
    { body: `${decl}sampleSrc(uv + U.u_texel * 0.5); return c;`, filter: 'linear' },
  ]
}

function checker(size: number): Rgba8 {
  const img: Rgba8 = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const v = (x + y) % 2 === 0 ? 255 : 0
      const i = (y * size + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  return img
}

function blendedFraction(img: Rgba8): number {
  let n = 0
  let k = 0
  for (let y = 2; y < img.height - 2; y++)
    for (let x = 2; x < img.width - 2; x++) {
      const v = img.data[(y * img.width + x) * 4 + 1]
      n++
      if (v > 8 && v < 247) k++
    }
  return n ? k / n : 0
}

// ===========================================================================
// Scoring one capture
// ===========================================================================

export interface Score {
  candidate: string
  backend: Backend
  stim: string
  frost: number
  dpr: number
  radiusPx: number
  taps: number
  fetches: number
  // blockiness
  acf1: number
  acf4: number
  acfMaxBeyond2: number
  shoulderLag: number
  domPeriod: number | null
  domAmp: number
  blockExcess: number
  // speckle
  vsGtMean: number
  vsGtP99: number
  vsFamilyMean: number
  vsFamilyP99: number
  speckleExcess: number
  // alpha
  alphaMean: number
  alphaMax: number
  // grain quality
  grainAnisotropy: number | null
}

function scoreOne(args: {
  candidate: Candidate
  backend: Backend
  stim: string
  frost: number
  dpr: number
  radiusPx: number
  img: Rgba8
  gt: Rgba8
  familyGt: Rgba8
  roi: Roi
}): Score {
  const { candidate: c, img, gt, familyGt, roi, dpr } = args
  const a = residualAcf(img, familyGt, roi, 16)
  const bp = blockPeriodSpectrum(img, roi, 16)
  const dGt = deviation(img, gt, roi)
  const dFam = deviation(img, familyGt, roi)
  const dc = directionalCorr(img, roi)
  return {
    candidate: c.id,
    backend: args.backend,
    stim: args.stim,
    frost: args.frost,
    dpr,
    radiusPx: args.radiusPx,
    taps: c.kernel.taps,
    fetches: r2(fetchesPerPixel(c)),
    acf1: r3(a.acf[0]),
    acf4: r3(a.acf[3]),
    acfMaxBeyond2: r3(Math.max(...a.acf.slice(2))),
    shoulderLag: a.shoulderLag,
    domPeriod: bp.dominantPeriod,
    domAmp: r3(bp.dominantAmplitude),
    blockExcess: r2(blockEdgeExcess(img, 4 * dpr, roi).excess),
    vsGtMean: r2(dGt.coveredMeanAbs),
    vsGtP99: dGt.coveredP99Abs,
    vsFamilyMean: r2(dFam.coveredMeanAbs),
    vsFamilyP99: dFam.coveredP99Abs,
    speckleExcess: r2(speckleRms(img, roi) - speckleRms(familyGt, roi)),
    alphaMean: r2(dGt.alphaMeanAbs),
    alphaMax: dGt.alphaMaxAbs,
    grainAnisotropy: dc.anisotropy === null ? null : r3(dc.anisotropy),
  }
}

// ===========================================================================
// COST.
//
// Per-capture wall-clock through playwright carries ~690 ms of fixed cost
// (shader compile + readback + IPC), which is 4 orders of magnitude more than
// the gather itself at 512x512. Timing individual candidates there would be
// pure noise. What IS measurable is the MARGINAL: run a tap ladder at
// 2048x2048 where the GPU work reaches a couple of Gfetch, take minMs (the
// minimum over repeats is the right estimator when the contaminant is additive
// scheduling noise), and measure the run-to-run floor with a replicate so the
// signal can be tested against it rather than against a guess.
//
// Everything else in the report is then a DERIVED cost: fetches/px x pixels /
// rate. That is honest about what was measured and what was extrapolated.
// ===========================================================================
export interface FetchRate {
  rows: Array<Record<string, number>>
  /** ms per Gfetch from a least-squares fit over the whole ladder. */
  msPerGfetch: number
  /** the same fit on the odd reps vs the even reps: the reproducibility check. */
  splitA: number
  splitB: number
  splitDisagreement: number
  /** scatter of the timed points about the fitted line, ms. */
  residRmsMs: number
  /** predicted ms across the whole ladder — the signal the fit is resolving. */
  spanMs: number
  usable: boolean
  gfetchPerSec: number | null
  size: number
  reps: number
}

/**
 * Measure the marginal cost of one dependent bilinear fetch.
 *
 * Two things make a naive version lie, both observed here:
 *   1. A ladder run in tap order (1, 32, 128, 512) aliases any monotone drift in
 *      GPU clocks straight onto the tap axis. The first entry runs on a cold
 *      GPU. Successive runs of the identical probe disagreed by 2x, and one run
 *      reported the marginal as unresolvable. The ladder is therefore
 *      INTERLEAVED: each rep visits every tap count, rotating the starting
 *      point, so drift spreads across the ladder instead of tilting it.
 *   2. An endpoint difference throws away the middle of the ladder and all of
 *      the redundancy. The rate is a least-squares slope over all four points.
 *
 * The verdict is then a REPRODUCIBILITY test, not a magnitude test: fit the odd
 * reps and the even reps separately and require the two slopes to agree. That
 * is the only criterion that would have caught the drift above.
 */
// 15 reps, not 9: the split-half test takes a MIN over each half, and a min over
// 4 samples is a noisy, biased estimator. At 9 reps the overall fit was stable to
// +-2% across runs (26.34 / 25.64 / 26.46 / 24.4 ms/Gfetch) while the split-half
// disagreement wandered 3.8% -> 26.6% and tripped its own 25% guard about one run
// in four. 7-8 samples per half settles it.
async function measureFetchRate(rig: Rig, input: Rgba8, reps = 15): Promise<FetchRate> {
  const size = input.width
  // Taps carry the signal; PIXELS carry the overhead. 2048 taps at 1024x1024 is
  // the same 2.1 Gfetch as 512 taps at 2048x2048 but reads back a quarter as
  // many bytes, which is where the run-to-run variance lives. Measured: the
  // 2048x2048 form put ~1670 ms of readback under a 47 ms signal and the
  // half-sample fits disagreed by up to 26%.
  const ladder = [1, 128, 512, 2048]
  const specs = ladder.map((taps) => ({
    taps,
    gfetch: (taps * size * size) / 1e9,
    spec: {
      backend: 'webgpu' as Backend,
      width: size,
      height: size,
      input,
      radius: 48,
      params: [1, 0, 2, 0] as [number, number, number, number],
      passes: frostPasses({
        backend: 'webgpu' as Backend,
        candidate: { id: `cost${taps}`, label: '', note: '', kernel: { taps, pattern: 'squareHash' as const, seed: 'pixel' as const } },
        radiusPx: 48,
        frost: 1,
        dpr: 2,
      }),
    },
  }))

  for (const s of specs) await rig.capture(s.spec) // warm every pipeline
  const times: number[][] = ladder.map(() => [])
  for (let r = 0; r < reps; r++)
    for (let k = 0; k < ladder.length; k++) {
      const i = (k + r) % ladder.length
      const t0 = performance.now()
      await rig.capture(specs[i].spec)
      times[i].push(performance.now() - t0)
    }

  // min over reps: the right estimator when the contaminant is additive
  // scheduling noise, which only ever adds time.
  const fit = (pick: (rep: number) => boolean) => {
    const xs: number[] = []
    const ys: number[] = []
    for (let i = 0; i < ladder.length; i++) {
      const sel = times[i].filter((_, r) => pick(r))
      if (!sel.length) continue
      xs.push(specs[i].gfetch)
      ys.push(Math.min(...sel))
    }
    const n = xs.length
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my)
      den += (xs[i] - mx) ** 2
    }
    return den > 0 ? num / den : 0
  }

  const msPerGfetch = fit(() => true)
  const splitA = fit((r) => r % 2 === 0)
  const splitB = fit((r) => r % 2 === 1)
  const mean = (splitA + splitB) / 2
  const splitDisagreement = mean > 0 ? Math.abs(splitA - splitB) / mean : 1

  // Reproducibility alone is not enough: a fit over a tiny x-range can be
  // self-consistent and still be noise. Require the predicted span across the
  // ladder to stand clear of the scatter of the points about the line.
  const mins = times.map((t) => Math.min(...t))
  const my2 = mins.reduce((a, b) => a + b, 0) / mins.length
  const mx2 = specs.reduce((a, b) => a + b.gfetch, 0) / specs.length
  const intercept = my2 - msPerGfetch * mx2
  let sq = 0
  for (let i = 0; i < specs.length; i++) sq += (mins[i] - (intercept + msPerGfetch * specs[i].gfetch)) ** 2
  const residRms = Math.sqrt(sq / specs.length)
  const span = msPerGfetch * (specs[specs.length - 1].gfetch - specs[0].gfetch)
  const usable = msPerGfetch > 0 && splitDisagreement < 0.25 && span > 5 * Math.max(residRms, 0.5)
  const rows = specs.map((s, i) => ({
    taps: s.taps,
    gfetch: r2(s.gfetch),
    minMs: r2(Math.min(...times[i])),
    medianMs: r2([...times[i]].sort((a, b) => a - b)[Math.floor(times[i].length / 2)]),
  }))
  return {
    rows,
    msPerGfetch: r2(msPerGfetch),
    splitA: r2(splitA),
    splitB: r2(splitB),
    splitDisagreement: r3(splitDisagreement),
    residRmsMs: r2(residRms),
    spanMs: r2(span),
    usable,
    gfetchPerSec: usable ? r2(1000 / msPerGfetch) : null,
    size,
    reps,
  }
}

// ===========================================================================
// The DPR-tier flip, the honest way (harness audit section 4).
//
// Re-seeding the hash at a FIXED grid only measures estimator variance. The real
// event is a joint change: the renderer's dprScale moves 1.0 -> 0.75, so the
// backing store resizes, u_dpr changes (which changes BOTH the jitter radius in
// device px and the lattice cell in device px), and the upstream pass texture is
// a different resolution. All three have to move together.
//
// Rendering the same CSS scene on two device grids and comparing them on one
// grid necessarily includes a pure RESAMPLE cost that has nothing to do with the
// estimator, so that floor is measured separately (A -> B grid -> A grid) and
// subtracted. The floor is content-dependent, so it is recomputed per candidate.
// ===========================================================================
export interface DprFlip {
  flipMean: number
  floorMean: number
  excess: number
  flipMax: number
}

async function dprFlipExcess(o: {
  rig: Rig
  backend: Backend
  candidate: Candidate
  cssStim: Rgba8
  frost: number
  dprA: number
  dprB: number
}): Promise<DprFlip> {
  const wA = Math.floor(o.cssStim.width * o.dprA)
  const hA = Math.floor(o.cssStim.height * o.dprA)
  const wB = Math.floor(o.cssStim.width * o.dprB)
  const hB = Math.floor(o.cssStim.height * o.dprB)
  const inA = resampleBilinear(o.cssStim, wA, hA)
  const inB = resampleBilinear(o.cssStim, wB, hB)
  const capA = await captureFrost({ rig: o.rig, backend: o.backend, input: inA, candidate: o.candidate, radiusPx: o.frost * 24 * o.dprA, frost: o.frost, dpr: o.dprA })
  const capB = await captureFrost({ rig: o.rig, backend: o.backend, input: inB, candidate: o.candidate, radiusPx: o.frost * 24 * o.dprB, frost: o.frost, dpr: o.dprB })
  const roi = insetRoi(wA, hA, Math.ceil(1.5 * o.frost * 24 * o.dprA) + 8)
  const flip = deviation(capA, resampleBilinear(capB, wA, hA), roi)
  // pure resample cost of this candidate's own high-frequency content
  const floor = deviation(capA, resampleBilinear(resampleBilinear(capA, wB, hB), wA, hA), roi)
  return {
    flipMean: r2(flip.coveredMeanAbs),
    floorMean: r2(floor.coveredMeanAbs),
    excess: r2(flip.coveredMeanAbs - floor.coveredMeanAbs),
    flipMax: flip.coveredMaxAbs,
  }
}

// ===========================================================================
// VALIDATE
// ===========================================================================

async function runValidate(): Promise<void> {
  const t0 = Date.now()
  const findings: Record<string, unknown> = {}

  // ---- A. image metrics on CPU synthetics --------------------------------
  console.log('\n=== A. IMAGE-METRIC CALIBRATION (CPU synthetics, DPR 2, R = 24 device px, block 8) ===')
  const rigForDecode = await createRig()
  let base: Rgba8
  try {
    const bytes = new Uint8Array(fs.readFileSync('stuff/2013-03-12 00.48.07.jpg'))
    base = centerCrop(await rigForDecode.decodeImage(bytes, 'image/jpeg', 1024), SIZE, SIZE)
  } finally {
    await rigForDecode.close()
  }
  const calibA = calibrateImageMetrics(base, 24, 8)
  console.log(
    `  ${pad('image', 40)}${padL('acf1', 7)}${padL('acf4', 7)}${padL('acf8', 7)}${padL('should', 7)}${padL('rms', 7)}${padL('degen', 7)}${padL('period', 7)}${padL('amp', 8)}${padL('prom', 7)}${padL('mean', 7)}${padL('p99', 6)}${padL('speckΔ', 8)}${padL('blockX', 8)}`,
  )
  for (const r of calibA.rows)
    console.log(
      `  ${pad(r.image, 40)}${padL(r.acf1, 7)}${padL(r.acf4, 7)}${padL(r.acf8, 7)}${padL(r.shoulder, 7)}${padL(r.residRms, 7)}${padL(r.acfDegenerate, 7)}${padL(r.domPeriod ?? '-', 7)}${padL(r.domAmp, 8)}${padL(r.prominence, 7)}${padL(r.devMean, 7)}${padL(r.devP99, 6)}${padL(r.speckleExcess, 8)}${padL(r.blockExcess, 8)}`,
    )
  findings.calibrationA = calibA.rows

  const byName = (s: string) => calibA.rows.find((r) => r.image.startsWith(s))!
  const gIdent = byName('GOOD conv (identical)')
  const gN1 = byName('GOOD conv + iid 1')
  const gN6 = byName('GOOD conv + iid 6')
  const bBlock = byName('BAD  block-quantised')
  const bShip = byName('BAD  shipped 8tap')
  const bGrain = byName('BAD  8tap per-pixel')
  const dFlat = byName('DEGEN flat grey')

  gate({
    metric: 'residualAcf.acf4 (blockiness)',
    goodLabel: 'conv + iid 6 codes',
    good: gN1.acfDegenerate ? `degenerate(${gN1.acf4})` : gN1.acf4,
    badLabel: 'shipped 8tap lattice',
    bad: bShip.acf4,
    threshold: '< 0.15',
    pass: gN6.acf4 < 0.15 && bShip.acf4 >= 0.15 && bBlock.acf4 >= 0.15,
    note: `known-good iid noise reads ${gN6.acf4}; block-quantised ${bBlock.acf4}; PER-PIXEL 8-tap grain (blockless) reads ${bGrain.acf4} => the metric does NOT confuse grain with blocks`,
  })
  gate({
    metric: 'residualAcf.shoulderLag (block size)',
    goodLabel: 'conv + iid 6 codes',
    good: gN6.shoulder,
    badLabel: 'shipped 8tap lattice (cell 8 device px)',
    bad: bShip.shoulder,
    threshold: '<= 1 for a blockless candidate',
    pass: gN6.shoulder <= 1 && bGrain.shoulder <= 1 && bShip.shoulder >= 3,
    note: `block-quantised(8) reads ${bBlock.shoulder}; the blockless 8-tap grain reads ${bGrain.shoulder}, so the shoulder measures BLOCK WIDTH and not noise amplitude`,
  })
  gate({
    metric: 'residualAcf degenerate guard',
    goodLabel: 'identical to reference',
    good: `${gIdent.acfDegenerate} (rms ${gIdent.residRms})`,
    badLabel: 'flat grey vs flat grey',
    bad: `${dFlat.acfDegenerate} (rms ${dFlat.residRms})`,
    threshold: 'no NaN, degenerate=true, acf and shoulder forced to 0',
    pass:
      gIdent.acfDegenerate &&
      dFlat.acfDegenerate &&
      gIdent.shoulder === 0 &&
      dFlat.shoulder === 0 &&
      Number.isFinite(gIdent.acf1) &&
      Number.isFinite(dFlat.acf1),
    note: 'a candidate indistinguishable from ground truth reports degenerate, which is a PASS not a failure',
  })
  gate({
    metric: 'blockPeriodSpectrum.dominantAmplitude (codes)',
    goodLabel: 'conv + iid 6 codes',
    good: gN6.domAmp,
    badLabel: 'shipped 8tap lattice',
    bad: bShip.domAmp,
    threshold: '< 0.25 codes',
    pass: gN6.domAmp < 0.25 && bShip.domAmp > 0.25 && bGrain.domAmp < 0.25,
    note: `period recovered: shipped ${bShip.domPeriod}, block-quant ${bBlock.domPeriod} (both 8 = 4*u_dpr); blockless 8-tap grain reads ${bGrain.domAmp} at period ${bGrain.domPeriod}`,
  })
  gate({
    metric: 'deviation.coveredMeanAbs vs converged (speckle, codes)',
    goodLabel: 'identical',
    good: gIdent.devMean,
    badLabel: '8tap per-pixel',
    bad: bGrain.devMean,
    threshold: '< 1.5 codes',
    pass: gIdent.devMean === 0 && bGrain.devMean > 1.5 && bShip.devMean > 1.5,
    note: 'purely additive; 0 on an exact match',
  })
  gate({
    metric: 'speckleRms excess over reference (codes)',
    goodLabel: 'identical',
    good: gIdent.speckleExcess,
    badLabel: '8tap per-pixel',
    bad: bGrain.speckleExcess,
    threshold: '< 1.0 codes',
    pass:
      Math.abs(gIdent.speckleExcess) < 0.05 &&
      bGrain.speckleExcess > 1.0 &&
      bGrain.speckleExcess > bBlock.speckleExcess,
    note: `NOT gated alone: block-quantisation LOWERS local variance (${bBlock.speckleExcess}) because it correlates neighbours, so speckle would rank the defect above its fix. Always paired with the two blockiness metrics.`,
  })
  gate({
    metric: 'blockEdgeExcess (phase-9a corroborator, codes)',
    goodLabel: 'conv + iid 6 codes',
    good: gN6.blockExcess,
    badLabel: 'shipped 8tap lattice',
    bad: bShip.blockExcess,
    threshold: '< 0.5 codes',
    pass: gN6.blockExcess < 0.5 && bShip.blockExcess > 0.5,
  })

  // ---- B. kernel-shape metrics on analytic PSFs --------------------------
  console.log('\n=== B. KERNEL-SHAPE CALIBRATION (analytic PSFs, R = 24 device px) ===')
  const calibB = await calibratePsf(24)
  console.log(`  ${pad('kind', 10)}${PSF_KEYS.map((k) => padL(k, 15)).join('')}`)
  for (const r of calibB) console.log(`  ${pad(r.kind, 10)}${PSF_KEYS.map((k) => padL(r[k], 15)).join('')}`)
  findings.calibrationB = calibB
  const P = (k: string) => calibB.find((r) => r.kind === k)!

  gate({
    metric: 'psf.squareness (square footprint)',
    goodLabel: 'analytic disc',
    good: P('disc').squareness,
    badLabel: 'analytic square',
    bad: P('square').squareness,
    threshold: '< 1.05',
    pass: P('disc').squareness < 1.05 && P('square').squareness > 1.15,
    note: `analytic answer for a uniform square with this wedge weighting is 1.199 (measured ${P('square').squareness}); anisotropyScore in lib/detectors.ts is BLIND to this (mxx == myy for both shapes) and is not used. Gaussian reads ${P('gauss').squareness}, confirming the metric sees SHAPE and not width.`,
  })
  gate({
    metric: 'psf.holeDeficit (centre hole)',
    goodLabel: 'analytic disc / analytic square',
    good: `${P('disc').holeDeficit} / ${P('square').holeDeficit}`,
    badLabel: 'annulus r>0.25R (un-jittered Vogel N=8)',
    bad: P('annulus').holeDeficit,
    threshold: '< 0.15',
    pass: Math.abs(P('disc').holeDeficit) < 0.15 && Math.abs(P('square').holeDeficit) < 0.15 && P('annulus').holeDeficit > 0.6,
    note: `density-relative, so a uniform SQUARE also reads ~0 — it is not a hole, it is a different footprint. rings8 reads ${P('rings8').holeDeficit}, gauss ${P('gauss').holeDeficit} (negative = centre-peaked, correct).`,
  })
  gate({
    metric: 'psf.ringiness (concentric rings)',
    goodLabel: 'analytic disc',
    good: P('disc').ringiness,
    badLabel: '8-ring sunflower shell set',
    bad: P('rings8').ringiness,
    threshold: '< 0.20',
    pass: P('disc').ringiness < 0.2 && P('square').ringiness < 0.2 && P('gauss').ringiness < 0.2 && P('rings8').ringiness > 0.5,
    note: `all three smooth kernels must sit low (disc ${P('disc').ringiness}, square ${P('square').ringiness}, gauss ${P('gauss').ringiness}) or the metric is just reading the radial cutoff`,
  })
  gate({
    metric: 'psf.profileL1Disc (radial profile, L1 in [0,2])',
    goodLabel: 'analytic disc',
    good: P('disc').profileL1Disc,
    badLabel: 'analytic Gaussian (matched 2nd moment)',
    bad: P('gauss').profileL1Disc,
    threshold: '< 0.10',
    pass: P('disc').profileL1Disc < 0.1 && P('gauss').profileL1Disc > 0.2 && P('gauss').profileL1Gauss < 0.1,
    note: 'the Gaussian scores ~0 against its OWN ideal, so the metric measures shape and not amplitude',
  })
  gate({
    metric: 'psf.massCaptured (conservation)',
    goodLabel: 'analytic disc',
    good: P('disc').massCaptured,
    badLabel: '(n/a — correctness assert)',
    bad: '-',
    threshold: '0.95 .. 1.05',
    pass: P('disc').massCaptured > 0.95 && P('disc').massCaptured < 1.05 && P('square').massCaptured > 0.95,
    note: 'if this drifts, the gain/dotMass bookkeeping is wrong and every shape number is wrong with it',
  })
  gate({
    metric: 'psf.clipFraction',
    goodLabel: 'analytic disc',
    good: P('disc').clipFraction,
    badLabel: '(n/a — correctness assert)',
    bad: '-',
    threshold: '== 0 for every kernel, after adaptive gain',
    pass: calibB.every((r) => r.clipFraction === 0),
    note: `the linear-gain egress must never saturate or the profile is truncated; the adaptive loop settled on gains ${calibB.map((r) => `${r.kind}=${r.gain}`).join(' ')} (a matched Gaussian peaks at 2x a disc, a thin ring far more)`,
  })

  // ---- C. GPU trust ------------------------------------------------------
  console.log('\n=== C. GPU TRUST CHECKS ===')
  const rig = await createRig()
  const gpu: Record<string, unknown> = {}
  try {
    console.log(`  backends available: webgpu=${rig.available.webgpu} webgl2=${rig.available.webgl2}`)
    gpu.available = rig.available
    gate({
      metric: 'both backends available',
      goodLabel: 'webgpu',
      good: String(rig.available.webgpu),
      badLabel: 'webgl2',
      bad: String(rig.available.webgl2),
      threshold: 'both true',
      pass: rig.available.webgpu && rig.available.webgl2,
    })

    // C1: pass-chain structure — the gather must never be pass 0 (WebGL2 bug).
    const chain = frostPasses({ backend: 'webgl2', candidate: CANDIDATES[0], radiusPx: 48, frost: 1, dpr: 2 })
    const gatherIdx = chain.findIndex((p) => p.body.includes('reedHash'))
    gate({
      metric: 'gather is never pass 0 (WebGL2 filter bug)',
      goodLabel: 'gather pass index',
      good: gatherIdx,
      badLabel: 'forbidden index',
      bad: 0,
      threshold: '>= 1',
      pass: gatherIdx >= 1,
      note: 'gpu-rig binds origTex at TEXTURE1 and forces NEAREST on it; on pass 0 srcTex IS origTex, so filter:linear is silently overwritten and every tap snaps to a texel centre — the harness would manufacture the exact artefact under investigation',
    })

    const chk = checker(128)
    const blend: Record<string, number> = {}
    for (const b of BACKENDS) {
      const out = await rig.capture({ backend: b, width: 128, height: 128, input: chk, passes: filterProbePasses(b) })
      blend[b] = r3(blendedFraction(out))
    }
    gpu.filterProbe = blend
    gate({
      metric: 'linear filtering live on the gather pass',
      goodLabel: 'webgpu blended fraction',
      good: blend.webgpu,
      badLabel: 'webgl2 blended fraction',
      bad: blend.webgl2,
      threshold: '> 0.95 on BOTH',
      pass: blend.webgpu > 0.95 && blend.webgl2 > 0.95,
      note: 'measured, not assumed: a half-texel diagonal offset on a 1-px checker must blend',
    })

    // C2: WGSL uniformity is genuinely exercised.
    let posControlRejected = false
    let posControlMsg = ''
    try {
      await rig.capture({ backend: 'webgpu', width: 64, height: 64, input: chk, passes: [{ body: 'return sampleSrc(uv);', filter: 'nearest' }, uniformityPositiveControl()] })
    } catch (e) {
      posControlRejected = true
      posControlMsg = String((e as Error).message).slice(0, 140)
    }
    gpu.uniformityPositiveControl = { rejected: posControlRejected, message: posControlMsg }
    gate({
      metric: 'WGSL uniformity rule is live (positive control)',
      goodLabel: 'our candidates (textureSampleLevel)',
      good: 'compile',
      badLabel: 'textureSample under a non-uniform branch',
      bad: posControlRejected ? 'REJECTED (correct)' : 'compiled (probe is dead)',
      threshold: 'positive control must be rejected',
      pass: posControlRejected,
      note: posControlMsg,
    })

    // C3: every candidate compiles + renders live on both backends, at both extremes.
    const smokeStim = centerCrop(base, 256, 256)
    const smoke: Array<Record<string, unknown>> = []
    let smokeFail = 0
    for (const c of CANDIDATES) {
      for (const b of BACKENDS) {
        for (const [frost, dpr] of [[1, 2], [0.25, 1]] as Array<[number, number]>) {
          const radiusPx = frost * 24 * dpr
          try {
            const out = await captureFrost({ rig, backend: b, input: smokeStim, candidate: c, radiusPx, frost, dpr })
            const d = deviation(out, smokeStim, insetRoi(256, 256, 60))
            smoke.push({ id: c.id, backend: b, frost, dpr, ok: true, meanVsSource: r2(d.coveredMeanAbs) })
          } catch (e) {
            smokeFail++
            smoke.push({ id: c.id, backend: b, frost, dpr, ok: false, error: String((e as Error).message).slice(0, 200) })
            console.log(`  SMOKE FAIL ${c.id}/${b} frost=${frost} dpr=${dpr}: ${(e as Error).message}`.slice(0, 220))
          }
        }
      }
    }
    gpu.smoke = smoke
    console.log(`  candidate smoke: ${smoke.length - smokeFail}/${smoke.length} captures live on both backends`)
    gate({
      metric: 'every candidate compiles + renders live, both backends',
      goodLabel: 'live captures',
      good: smoke.length - smokeFail,
      badLabel: 'failures',
      bad: smokeFail,
      threshold: '0 failures',
      pass: smokeFail === 0,
      note: 'each capture is asserted non-black AND non-constant; a dropped draw or an unscoped OOM would otherwise read as perfectly smooth frost and win the bake-off',
    })

    // C4: the 256-tap GPU ground truth really is ground truth.
    const R = 24
    const gtStim = centerCrop(base, SIZE, SIZE)
    const roi = insetRoi(SIZE, SIZE, Math.ceil(1.5 * R) + 8)
    const cpuConv = encodeToSrgb8(discBlurFast(decodeToLinear(gtStim), R, { premultiplied: true }))
    const gtCand = CANDIDATES.find((c) => c.id === 'C7')!
    const negCand = CANDIDATES.find((c) => c.id === 'C3j-16')!
    const gtRes: Record<string, number> = {}
    for (const b of BACKENDS) {
      const gtImg = await captureFrost({ rig, backend: b, input: gtStim, candidate: gtCand, radiusPx: R, frost: 0.5, dpr: 2 })
      gtRes[b] = r2(deviation(gtImg, cpuConv, roi).coveredMeanAbs)
      if (b === 'webgpu') save(IMG_DIR, 'validate-C7-webgpu-r24', gtImg)
    }
    const negImg = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: negCand, radiusPx: R, frost: 0.5, dpr: 2 })
    const negDev = r2(deviation(negImg, cpuConv, roi).coveredMeanAbs)
    save(IMG_DIR, 'validate-cpu-converged-r24', cpuConv)
    gpu.groundTruthCheck = { ...gtRes, negativeControl_C3j16: negDev }
    gate({
      metric: 'C7 (GPU 256-tap) == CPU converged disc (codes)',
      goodLabel: 'C7 webgpu / webgl2',
      good: `${gtRes.webgpu} / ${gtRes.webgl2}`,
      badLabel: 'negative control C3j-16',
      bad: negDev,
      // Threshold set FROM the two measurements, not guessed: at 1.5 codes the
      // 16-tap negative control also passed, which would have made the gate
      // vacuous. 0.5 sits 3.6x above C7 and 2.8x below the negative control.
      threshold: '< 0.5 codes',
      pass: gtRes.webgpu < 0.5 && gtRes.webgl2 < 0.5 && negDev > 0.5,
      note: 'two independent implementations (fp64 CPU disc convolution vs fp32 GPU stochastic gather) agreeing to a fraction of a code is what makes C7 usable as an anchor; the 16-tap negative control must FAIL the same gate, or the gate is vacuous',
    })

    // C5: cross-backend agreement on the SHIPPED candidate (statistical, not byte).
    const c0 = CANDIDATES.find((c) => c.id === 'C0')!
    const xb: Record<string, Score> = {}
    const gtImgWG = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: gtCand, radiusPx: R, frost: 0.5, dpr: 2 })
    for (const b of BACKENDS) {
      const img = await captureFrost({ rig, backend: b, input: gtStim, candidate: c0, radiusPx: R, frost: 0.5, dpr: 2 })
      xb[b] = scoreOne({ candidate: c0, backend: b, stim: 'photo-street', frost: 0.5, dpr: 2, radiusPx: R, img, gt: gtImgWG, familyGt: gtImgWG, roi })
      if (b === 'webgpu') save(IMG_DIR, 'validate-C0-webgpu-r24', img)
    }
    const dAcf = Math.abs(xb.webgpu.acf4 - xb.webgl2.acf4)
    const dMean = Math.abs(xb.webgpu.vsGtMean - xb.webgl2.vsGtMean)
    gpu.crossBackend = { webgpu: xb.webgpu, webgl2: xb.webgl2, dAcf4: r3(dAcf), dMean: r2(dMean) }
    gate({
      metric: 'cross-backend statistical agreement (C0)',
      goodLabel: '|d acf4|',
      good: r3(dAcf),
      badLabel: '|d meanVsGT| codes',
      bad: r2(dMean),
      threshold: '|d acf4| < 0.10 and |d mean| < 1.0 code',
      pass: dAcf < 0.1 && dMean < 1.0,
      note: 'byte equality is NOT the gate. The rig feeds the hash from the interpolated uv, which is bit-identical on both backends, so an exact 0 here is EXPECTED and is not evidence about the engine — there rg_coords reaches the hash through cos/sin/division, where a 1-ULP backend difference completely changes a floatBitsToUint result. Engine parity must be gated on statistics, never on pixels.',
    })

    // C6: the emitters are not silently equivalent, and the two emission paths
    // for one kernel agree. Both are copy-paste-bug detectors.
    const distinctIds = ['C0', 'C1', 'C2', 'C3-8', 'C3j-8', 'C5-8']
    const distinctImgs: Record<string, Rgba8> = {}
    for (const id of distinctIds)
      distinctImgs[id] = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: CANDIDATES.find((c) => c.id === id)!, radiusPx: R, frost: 0.5, dpr: 2 })
    let minPair = Infinity
    let minPairName = ''
    for (let i = 0; i < distinctIds.length; i++)
      for (let j = i + 1; j < distinctIds.length; j++) {
        const d = deviation(distinctImgs[distinctIds[i]], distinctImgs[distinctIds[j]], roi).coveredMeanAbs
        if (d < minPair) {
          minPair = d
          minPairName = `${distinctIds[i]}/${distinctIds[j]}`
        }
      }
    // Known-bad for this gate: a genuinely collapsed pair. Same kernel, different
    // id — it MUST read exactly 0, which is what fixes the threshold from data
    // instead of guessing one (a guessed 1.0 code failed the closest honest pair).
    const c38 = CANDIDATES.find((c) => c.id === 'C3-8')!
    const clone: Candidate = { ...c38, id: 'C3-8-clone' }
    const cloneImg = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: clone, radiusPx: R, frost: 0.5, dpr: 2 })
    const collapsed = deviation(distinctImgs['C3-8'], cloneImg, roi)
    gpu.distinctness = { minPairMean: r2(minPair), pair: minPairName, collapsedMean: r2(collapsed.coveredMeanAbs), collapsedMax: collapsed.coveredMaxAbs }
    gate({
      metric: 'candidates are actually distinct',
      goodLabel: 'closest honest pair',
      good: `${minPairName}=${r2(minPair)}`,
      badLabel: 'collapsed control (C3-8 vs its clone)',
      bad: `${r2(collapsed.coveredMeanAbs)} mean / ${collapsed.coveredMaxAbs} max`,
      threshold: 'closest pair > 0.2 codes AND the collapsed control reads exactly 0',
      pass: minPair > 0.2 && collapsed.coveredMeanAbs === 0 && collapsed.coveredMaxAbs === 0,
      note: `a seed or rotation expression silently dropped would make two candidates identical, exactly as the clone control does. The closest honest pair is ${minPairName} at ${r2(minPair)} codes — radial jitter barely moves an N=8 sunflower ON A PHOTO, though it changes the PSF a great deal (see the kernel-shape table); that is a finding, not a collapse.`,
    })

    const bakedC = CANDIDATES.find((c) => c.id === 'C3j-16')!
    const procC: Candidate = { ...bakedC, id: 'C3j-16-proc', kernel: { ...bakedC.kernel, emit: 'procedural' } }
    const bakedImg = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: bakedC, radiusPx: R, frost: 0.5, dpr: 2 })
    const procImg = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: procC, radiusPx: R, frost: 0.5, dpr: 2 })
    const sb = scoreOne({ candidate: bakedC, backend: 'webgpu', stim: 'photo-street', frost: 0.5, dpr: 2, radiusPx: R, img: bakedImg, gt: gtImgWG, familyGt: gtImgWG, roi })
    const sp = scoreOne({ candidate: procC, backend: 'webgpu', stim: 'photo-street', frost: 0.5, dpr: 2, radiusPx: R, img: procImg, gt: gtImgWG, familyGt: gtImgWG, roi })
    gpu.emitParity = { baked: sb, procedural: sp }
    gate({
      metric: 'baked vs procedural emitter parity (C3j-16)',
      goodLabel: '|d meanVsGT| codes',
      good: r2(Math.abs(sb.vsGtMean - sp.vsGtMean)),
      badLabel: '|d acf4|',
      bad: r3(Math.abs(sb.acf4 - sp.acf4)),
      threshold: '|d mean| < 0.3 code and |d acf4| < 0.05',
      pass: Math.abs(sb.vsGtMean - sp.vsGtMean) < 0.3 && Math.abs(sb.acf4 - sp.acf4) < 0.05,
      note: 'statistical, not pixel: the two paths round the per-tap hash salt differently (fp32 fi*3.17 on the GPU vs an fp64 literal rounded at emission), and a 1-ULP difference in a bit-hash input gives a completely different draw from the same distribution',
    })

    // ---- D. re-roll + cost ------------------------------------------------
    console.log('\n=== D. RE-ROLL AND COST CALIBRATION ===')
    const rr: Array<Record<string, unknown>> = []
    for (const id of ['C0', 'C1', 'C3j-16', 'C7']) {
      const c = CANDIDATES.find((x) => x.id === id)!
      const a = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: c, radiusPx: R, frost: 0.5, dpr: 2, seedPhase: 0 })
      const b = await captureFrost({ rig, backend: 'webgpu', input: gtStim, candidate: c, radiusPx: R, frost: 0.5, dpr: 2, seedPhase: 977 })
      const d = deviation(a, b, roi)
      rr.push({ id, taps: c.kernel.taps, rerollMean: r2(d.coveredMeanAbs), rerollP99: d.coveredP99Abs, rerollMax: d.coveredMaxAbs })
    }
    console.log(`  ${pad('cand', 10)}${padL('taps', 6)}${padL('mean', 8)}${padL('p99', 7)}${padL('max', 7)}   (8-bit codes, seed phase 0 -> 977)`)
    for (const r of rr) console.log(`  ${pad(r.id, 10)}${padL(r.taps, 6)}${padL(r.rerollMean, 8)}${padL(r.rerollP99, 7)}${padL(r.rerollMax, 7)}`)
    gpu.reroll = rr
    const m = (id: string) => rr.find((r) => r.id === id)!.rerollMean as number
    gate({
      metric: 're-roll delta (codes) falls with tap count',
      goodLabel: 'C7 (256 taps)',
      good: m('C7'),
      badLabel: 'C1 (8 taps)',
      bad: m('C1'),
      threshold: 'monotone decreasing in N, C7 < 1.5 codes',
      pass: m('C7') < 1.5 && m('C7') < m('C3j-16') && m('C3j-16') < m('C1'),
      note: `C0 (lattice, 8 taps) reads ${m('C0')} — the lattice re-rolls too, it just re-rolls in 8x8 patches`,
    })

    // D2: the real DPR-tier flip, with its resample floor subtracted.
    const cssStim = centerCrop(base, 192, 192)
    const flips: Array<Record<string, unknown>> = []
    for (const id of ['C0', 'C1', 'C3j-16', 'C7']) {
      const c = CANDIDATES.find((x) => x.id === id)!
      const f = await dprFlipExcess({ rig, backend: 'webgpu', candidate: c, cssStim, frost: 0.5, dprA: 2.0, dprB: 1.5 })
      flips.push({ id, taps: c.kernel.taps, ...f })
    }
    console.log(`  ${pad('cand', 10)}${padL('taps', 6)}${padL('flip', 8)}${padL('floor', 8)}${padL('excess', 8)}${padL('flipMax', 9)}   (dpr 2.0 -> 1.5, CSS 192px, frost 0.5)`)
    for (const r of flips) console.log(`  ${pad(r.id, 10)}${padL(r.taps, 6)}${padL(r.flipMean, 8)}${padL(r.floorMean, 8)}${padL(r.excess, 8)}${padL(r.flipMax, 9)}`)
    gpu.dprFlip = flips
    const ex = (id: string) => flips.find((r) => r.id === id)!.excess as number
    gate({
      metric: 'DPR-tier flip excess over the resample floor (codes)',
      goodLabel: 'C7 (256 taps)',
      good: ex('C7'),
      badLabel: 'C1 (8 taps, per-pixel seed)',
      bad: ex('C1'),
      threshold: 'excess falls with tap count; C7 < 1.5 codes',
      pass: ex('C7') < 1.5 && ex('C7') < ex('C1'),
      note: `the floor is subtracted per candidate because it depends on that candidate's own high-frequency content; C0 (the lattice, which is DPR-invariant by construction) reads ${ex('C0')} — that is the number the lattice was added to buy`,
    })

    const COST_SIZE = 1024
    // resampleBilinear, NOT centerCrop: centerCrop CLAMPS to the source size, so
    // asking a 512x512 photo for a 2048x2048 crop silently returns 512x512 and the
    // probe measures 1/16 of the intended GPU work.
    const fr = await measureFetchRate(rig, resampleBilinear(base, COST_SIZE, COST_SIZE))
    // (COST_SIZE is the render size; the tap ladder supplies the signal.)
    console.log(`  ${pad('taps', 8)}${padL('Gfetch', 9)}${padL('medianMs', 11)}${padL('minMs', 9)}   (${COST_SIZE}x${COST_SIZE}, webgpu, ${fr.reps} interleaved reps)`)
    for (const r of fr.rows) console.log(`  ${pad(r.taps, 8)}${padL(r.gfetch, 9)}${padL(r.medianMs, 11)}${padL(r.minMs, 9)}`)
    console.log(`  fit ${fr.msPerGfetch} ms/Gfetch; odd/even half-fits ${fr.splitA}/${fr.splitB} (${r2(fr.splitDisagreement * 100)}% apart); span ${fr.spanMs} ms vs residual scatter ${fr.residRmsMs} ms`)
    gpu.cost = fr
    gate({
      metric: 'COST: is the marginal fetch rate reproducible?',
      goodLabel: 'odd-rep fit (ms/Gfetch)',
      good: fr.splitA,
      badLabel: 'even-rep fit (ms/Gfetch)',
      bad: fr.splitB,
      threshold: 'half-sample fits agree within 25% AND ladder span > 5x residual scatter',
      // A DETERMINATION, not a quality veto: it selects which cost number the
      // report is allowed to quote. Failing the suite on a flaky timing probe
      // would make the suite itself flaky and teach the reader to ignore it.
      pass: true,
      note: fr.usable
        ? `${fr.gfetchPerSec} Gfetch/s. Half-samples disagree by ${r2(fr.splitDisagreement * 100)}%; ladder span ${fr.spanMs} ms against ${fr.residRmsMs} ms of scatter. Quoted as a MARGINAL only: ${fr.rows[0].minMs} ms of every capture is shader compile + readback + IPC. Per-candidate cost in the report is DERIVED as fetches/px x pixels / rate and labelled as derived.`
        : `NOT TRUSTWORTHY: half-samples ${r2(fr.splitDisagreement * 100)}% apart, ladder span ${fr.spanMs} ms against ${fr.residRmsMs} ms of scatter. The report will quote tap count and fetches-per-pixel ONLY rather than invent a timing number.`,
    })
    findings.timingUsable = fr.usable
    findings.cost = fr
  } finally {
    await rig.close()
  }
  findings.gpu = gpu

  // ---- summary -----------------------------------------------------------
  console.log('\n=== VALIDATION TABLE ===')
  console.log(
    `  ${pad('metric', 46)}${pad('known-good', 34)}${pad('known-bad', 34)}${pad('threshold', 34)}  verdict`,
  )
  for (const g of gates) {
    console.log(
      `  ${pad(g.metric, 46)}${pad(`${g.goodLabel}=${g.good}`, 34)}${pad(`${g.badLabel}=${g.bad}`, 34)}${pad(g.threshold, 34)}  ${g.pass ? 'PASS' : 'FAIL'}`,
    )
    if (g.note) console.log(`      note: ${g.note}`)
  }
  const failed = gates.filter((g) => !g.pass)
  console.log(`\n  ${gates.length - failed.length}/${gates.length} gates pass.`)
  if (failed.length) console.log(`  !!! ${failed.map((f) => f.metric).join(', ')}`)

  findings.gates = gates
  findings.allPassed = failed.length === 0
  findings.candidates = CANDIDATES.map((c) => ({
    id: c.id,
    label: c.label,
    taps: c.kernel.taps,
    fetches: r2(fetchesPerPixel(c)),
    kernel: c.kernel,
    pyramidDepth: c.pyramidDepth ?? 0,
    familyRef: familyRef(c),
    note: c.note,
  }))
  findings.elapsedSec = Math.round((Date.now() - t0) / 100) / 10

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const p = path.join(OUT_DIR, 'phase9-validate.json')
  fs.writeFileSync(p, JSON.stringify(findings, null, 2))
  console.log(`\n  wrote ${p}`)
  console.log(`  wrote ${files.length} png(s) under ${IMG_DIR}`)
  console.log(`  elapsed ${findings.elapsedSec}s`)
}

// ===========================================================================
// SWEEP
// ===========================================================================

const SWEEP_FROST = [0.125, 0.25, 0.5, 0.75, 1.0]
const SWEEP_DPR = [1, 2]

/**
 * --quick shrinks the matrix to one backend / one DPR / one frost / two stimuli
 * and writes to phase9-quick.*, so the sweep CODE PATH (scoring, PSF capture,
 * markdown, PNG writing) can be proven end-to-end without pretending a partial
 * run is the bake-off. The full run writes phase9.json / phase9.md.
 */
async function runSweep(quick: boolean): Promise<void> {
  const t0 = Date.now()
  const backends = quick ? (['webgpu'] as Backend[]) : BACKENDS
  const dprs = quick ? [2] : SWEEP_DPR
  const frosts = quick ? [1.0] : SWEEP_FROST
  const suffix = quick ? '-quick' : ''
  let nCap = 0
  const rig = await createRig()
  const rows: Score[] = []
  const psfRows: Array<Record<string, unknown>> = []
  const rerollRows: Array<Record<string, unknown>> = []
  const flipRows: Array<Record<string, unknown>> = []
  let fetchRate: FetchRate | null = null
  try {
    const all = await loadStimuli(rig)
    const stims = quick ? all.filter((s) => s.name === 'photo-street' || s.name === 'alpha-sprite') : all
    for (const s of stims) save(IMG_DIR, `source-${s.name}`, s.img)

    for (const backend of backends) {
      for (const dpr of dprs) {
        for (const frost of frosts) {
          const radiusPx = frost * 24 * dpr
          const inset = Math.ceil(1.5 * radiusPx) + 8
          const roi = insetRoi(SIZE, SIZE, inset)

          for (const stim of stims) {
            // converged anchors first: one per family
            const anchors: Record<string, Rgba8> = {}
            for (const id of ['C7', 'GTsq', 'GTg']) {
              const c = CANDIDATES.find((x) => x.id === id)!
              anchors[id] = await captureFrost({ rig, backend, input: stim.img, candidate: c, radiusPx, frost, dpr })
              nCap++
            }
            for (const c of CANDIDATES) {
              const img = c.groundTruth ? anchors[c.id] : await captureFrost({ rig, backend, input: stim.img, candidate: c, radiusPx, frost, dpr })
              if (!c.groundTruth) nCap++
              rows.push(
                scoreOne({
                  candidate: c,
                  backend,
                  stim: stim.name,
                  frost,
                  dpr,
                  radiusPx,
                  img,
                  gt: anchors.C7,
                  familyGt: anchors[familyRef(c)],
                  roi,
                }),
              )
              // decisive cases only: the widest radius at DPR 2 on WebGPU, where
              // sparse-sampling artefacts are worst. Every candidate gets a 4x
              // nearest zoom beside the 256-tap ground truth; full-size frames
              // only for the anchors of the argument (disk budget).
              if (backend === 'webgpu' && frost === 1 && dpr === 2 && (stim.name === 'photo-street' || stim.name === 'ui-screenshot')) {
                if (['C0', 'C1', 'C2', 'C3j-16', 'C5j-16', 'C7'].includes(c.id)) save(IMG_DIR, `${stim.name}-dpr2-f100-${c.id}`, img)
                save(
                  IMG_DIR,
                  `zoom-${stim.name}-dpr2-f100-${c.id}`,
                  montage([cropZoom(img, 200, 200, 96, 96, 4), cropZoom(anchors.C7, 200, 200, 96, 96, 4)]),
                )
              }
            }

            // Re-roll, on the photo and on WebGPU only. It is a property of the
            // sampling pattern, not of the backend (validated: C0 is
            // bit-identical across backends in this rig), so running it on both
            // would double the capture count for no information.
            if (stim.name === 'photo-street' && backend === 'webgpu') {
              for (const c of CANDIDATES) {
                const a = await captureFrost({ rig, backend, input: stim.img, candidate: c, radiusPx, frost, dpr, seedPhase: 0 })
                const b = await captureFrost({ rig, backend, input: stim.img, candidate: c, radiusPx, frost, dpr, seedPhase: 977 })
                nCap += 2
                const d = deviation(a, b, roi)
                rerollRows.push({ candidate: c.id, backend, frost, dpr, mean: r2(d.coveredMeanAbs), p99: d.coveredP99Abs, max: d.coveredMaxAbs })
              }
            }
          }
        }
      }
    }

    // The DPR-tier flip (1.0 -> 0.75 dprScale at devicePixelRatio 2, i.e.
    // u_dpr 2.0 -> 1.5), measured per candidate at three frost values on the
    // photo. This is the temporal risk of dropping the lattice, priced.
    const cssStim = centerCrop(stims[0].img, 192, 192)
    for (const frost of quick ? [1.0] : [0.25, 0.5, 1.0]) {
      for (const c of CANDIDATES) {
        const f = await dprFlipExcess({ rig, backend: 'webgpu', candidate: c, cssStim, frost, dprA: 2.0, dprB: 1.5 })
        nCap += 2
        flipRows.push({ candidate: c.id, backend: 'webgpu', frost, ...f })
      }
    }

    // Kernel shape: measured once per (candidate, dpr) at the widest radius on
    // WebGPU. Shape does not depend on the stimulus, only on the tap pattern.
    for (const dpr of dprs) {
      const R = 24 * dpr
      const half = Math.ceil(R * PSF_EXTENT) + 2
      const { img: field, centers, dotMass } = impulseField(PSF_SIZE, 2 * half + 12, PSF_DOT)
      const inner = centers.filter(([x, y]) => x - half >= 0 && y - half >= 0 && x + half < PSF_SIZE && y + half < PSF_SIZE)
      for (const c of CANDIDATES) {
        const { stats: s, gain, attempts, captures, img: out } = await measurePsfAdaptive(
          (g, ph) => captureFrost({ rig, backend: 'webgpu', input: field, candidate: c, radiusPx: R, frost: 1, dpr, psfGain: g, seedPhase: ph }),
          inner,
          R,
          dotMass,
          quick ? [0, 977] : PSF_PHASES,
        )
        psfRows.push({
          candidate: c.id,
          dpr,
          R,
          gain: Math.round(gain),
          gainAttempts: attempts,
          psfCaptures: captures,
          phasesAveraged: quick ? 2 : PSF_PHASES.length,
          squareness: r3(s.squareness),
          holeDeficit: r3(s.holeDeficit),
          massOutsideR: r3(s.massOutsideR),
          profileL1Disc: r3(s.profileL1Disc),
          profileL1Gauss: r3(s.profileL1Gauss),
          ringiness: r3(s.ringiness),
          clipFraction: r3(s.clipFraction),
          massCaptured: r3(s.massCaptured),
          binR: s.binR.map(r3),
          binDensity: s.binDensity.map(r3),
        })
        nCap += captures
        if (dpr === 2) save(IMG_DIR, `psf-${c.id}-dpr2`, cropZoom(out, centers[0][0] - half, centers[0][1] - half, 2 * half + 1, 2 * half + 1, 1))
      }
    }

    // Cost: one marginal-rate measurement, from which every per-candidate cost
    // in the report is DERIVED (and labelled as such).
    fetchRate = await measureFetchRate(rig, resampleBilinear(stims[0].img, 1024, 1024))
    nCap += fetchRate.rows.length * 8
  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const payload = {
    generated: new Date().toISOString(),
    geometry: { halfExtentPx: 'frost * 24 * u_dpr device px', latticeCellPx: '4 * u_dpr device px', size: SIZE },
    candidates: CANDIDATES.map((c) => ({ id: c.id, label: c.label, taps: c.kernel.taps, fetches: r2(fetchesPerPixel(c)), kernel: c.kernel, familyRef: familyRef(c), note: c.note })),
    quick,
    captures: nCap,
    cost: fetchRate,
    costNote:
      'GPU wall-clock per capture is ~690 ms of shader compile + readback + IPC in this rig, so per-candidate totals are meaningless. What is measured is the MARGINAL fetch rate (see cost.gfetchPerSec); the per-candidate ms columns are DERIVED from it as fetches/px x pixels / rate, and are a lower bound that ignores ALU and cache effects.',
    rows,
    psf: psfRows,
    reroll: rerollRows,
    dprFlip: flipRows,
    files,
    elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
  }
  fs.writeFileSync(path.join(OUT_DIR, `phase9${suffix}.json`), JSON.stringify(payload, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, `phase9${suffix}.md`), renderMarkdown(payload))
  console.log(
    `wrote ${path.join(OUT_DIR, `phase9${suffix}.json`)} and phase9${suffix}.md ` +
      `(${rows.length} rows, ${nCap} gpu captures, ${files.length} pngs, ${payload.elapsedSec}s)`,
  )
}

function renderMarkdown(p: {
  rows: Score[]
  psf: Array<Record<string, unknown>>
  reroll: Array<Record<string, unknown>>
  dprFlip: Array<Record<string, unknown>>
  candidates: Array<Record<string, unknown>>
  cost: FetchRate | null
}): string {
  const L: string[] = []
  L.push('# Phase 9b — frost bake-off\n')
  L.push('All deviations are 8-bit sRGB codes. `vsGT` is against C7 (256-tap stratified disc);')
  L.push('`vsFam` is against the converged version of the candidate\'s own kernel family, which')
  L.push('separates estimator noise from footprint shape.\n')
  const rate = p.cost?.gfetchPerSec ?? null
  const ms = (f: number, px: number) => (rate ? `${Math.round(((f * px) / (rate * 1e9)) * 1e4) / 10}` : 'n/a')
  L.push('## Candidates\n')
  if (rate) {
    L.push(`Cost columns are DERIVED from a single measured marginal rate of **${rate} Gfetch/s**`)
    L.push(`(least-squares fit over an interleaved tap ladder at ${p.cost!.size}x${p.cost!.size}, ${p.cost!.reps} reps; the odd-rep and`)
    L.push(`even-rep half-sample fits agree to ${Math.round(p.cost!.splitDisagreement * 1000) / 10}%). Per-capture wall-clock is dominated by shader`)
    L.push('compile + readback + IPC and is NOT quoted. The derived ms is a lower bound: it counts')
    L.push('dependent bilinear fetches only, ignoring ALU and cache behaviour.\n')
  } else {
    L.push('GPU timing was NOT resolvable in this rig; cost is tap count and fetches/px only.\n')
  }
  L.push('| id | taps | fetches/px | ms @1080p | ms @4K | family ref | note |')
  L.push('|---|---|---|---|---|---|---|')
  for (const c of p.candidates)
    L.push(`| ${c.id} | ${c.taps} | ${c.fetches} | ${ms(c.fetches as number, 1920 * 1080)} | ${ms(c.fetches as number, 3840 * 2160)} | ${c.familyRef} | ${c.note} |`)

  L.push('\n## Per-row results\n')
  L.push('| cand | backend | stim | frost | dpr | R px | acf1 | acf4 | shoulder | period | amp | blockX | vsGT mean | vsGT p99 | vsFam mean | speckleΔ | alphaMax | anis |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of p.rows)
    L.push(
      `| ${r.candidate} | ${r.backend} | ${r.stim} | ${r.frost} | ${r.dpr} | ${r.radiusPx} | ${r.acf1} | ${r.acf4} | ${r.shoulderLag} | ${r.domPeriod ?? '-'} | ${r.domAmp} | ${r.blockExcess} | ${r.vsGtMean} | ${r.vsGtP99} | ${r.vsFamilyMean} | ${r.speckleExcess} | ${r.alphaMax} | ${r.grainAnisotropy ?? '-'} |`,
    )

  L.push('\n## Kernel shape (impulse response)\n')
  L.push('`massCaptured` is the VALIDITY flag, not a quality score: it is the fraction of emitted')
  L.push('impulse mass the measurement recovered. Outside 0.95-1.05 the other columns in that row')
  L.push('are estimates from an under-sampled ensemble and should not be read to 3 digits. A')
  L.push('lattice-seeded candidate is the case that needs watching — its sample set is fixed per')
  L.push('cell, so the translated cells neither tile nor cover the plane, and one realisation came')
  L.push('in 8.7%% light before phase averaging was added.\n')
  L.push('| cand | dpr | R | squareness | holeDeficit | massOutsideR | L1 vs disc | L1 vs gauss | ringiness | massCaptured |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of p.psf)
    L.push(`| ${r.candidate} | ${r.dpr} | ${r.R} | ${r.squareness} | ${r.holeDeficit} | ${r.massOutsideR} | ${r.profileL1Disc} | ${r.profileL1Gauss} | ${r.ringiness} | ${r.massCaptured} |`)

  L.push('\n## Re-roll stability (seed phase 0 -> 977)\n')
  L.push('| cand | backend | frost | dpr | mean | p99 | max |')
  L.push('|---|---|---|---|---|---|---|')
  for (const r of p.reroll) L.push(`| ${r.candidate} | ${r.backend} | ${r.frost} | ${r.dpr} | ${r.mean} | ${r.p99} | ${r.max} |`)

  L.push('\n## DPR-tier flip (u_dpr 2.0 -> 1.5), resample floor subtracted\n')
  L.push('| cand | backend | frost | flip | floor | excess | flip max |')
  L.push('|---|---|---|---|---|---|---|')
  for (const r of p.dprFlip) L.push(`| ${r.candidate} | ${r.backend} | ${r.frost} | ${r.flipMean} | ${r.floorMean} | ${r.excess} | ${r.flipMax} |`)
  return L.join('\n') + '\n'
}

// ===========================================================================

const argv = process.argv.slice(2)
const doSweep = argv.includes('--sweep')
;(doSweep ? runSweep(argv.includes('--quick')) : runValidate()).catch((e) => {
  console.error(e)
  process.exit(1)
})
