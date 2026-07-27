/**
 * Phase 3c — the rest of the suite: directional, radial, bokeh, progressive.
 *
 * Same rig, same ingest/egress bracket, same principle: flawlessness first, cost
 * second. Each category has its own notion of "correct", so each is judged
 * against the right reference rather than against an isotropic Gaussian:
 *   directional -> 1D Gaussian along the vector
 *   radial      -> no closed-form CPU reference; judged on artifacts + the eye
 *   bokeh       -> a true disc gather (flat top, hard edge)
 *   progressive -> smoothness of the hand-off between blur levels
 *
 * Run: npx tsx scripts/blur-bakeoff/phase3c-suite.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Rig, type Backend, type PassSpec } from './lib/gpu-rig'
import {
  ingestPass, egressPass, directionalPass, radialPass, discGatherPass,
  skewedBoxPass, progressiveStepPass, linearSampledGaussPass,
} from './lib/shaders'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './lib/image'
import { directionalBlur, discBlur } from './lib/reference2'
import { transitionStepping, ringingScore, rampSteppingScore, blurRampProfile } from './lib/detectors'
import { encodePng } from './lib/png'
import { hfNoise, pointOnBlack, brightPointField, stepEdge } from './lib/corpus'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase3c')
const B: Backend = 'webgpu'

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMG_DIR, `${name}.png`), encodePng(img))
}
function meanAbs(a: Rgba8, b: Rgba8): number {
  let s = 0, n = 0
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
const bracket = (k: PassSpec[]): PassSpec[] => [ingestPass(B), ...k, egressPass(B, { dither: true })]
function countTaps(passes: PassSpec[]): number {
  return passes.reduce((n, p) => n + (p.body.match(/sampleSrc\(/g)?.length ?? 0), 0)
}

interface Row {
  category: string
  variant: string
  taps: number
  passes: number
  metrics: Record<string, number>
  flaws: string[]
}
const rows: Row[] = []
const notes: string[] = []

// ---------------------------------------------------------------------------
// Directional (motion)
// ---------------------------------------------------------------------------
async function directional(rig: Rig) {
  const SIZE = 384
  const src = hfNoise(SIZE, SIZE, 21)
  save('dir-source', src)

  for (const sigma of [8, 32]) {
    const ref = encodeToSrgb8(directionalBlur(decodeToLinear(src), sigma, [1, 0.35], { premultiplied: true }))
    if (sigma === 32) save('dir-reference-s32', ref)

    // full tap count vs deliberately undersampled
    for (const cap of [0, 9] as const) {
      const passes = bracket([directionalPass(B, sigma, cap || undefined)])
      const out = await rig.capture({
        backend: B, width: SIZE, height: SIZE, input: src,
        passes, direction: [1, 0.35],
      })
      const label = cap ? `undersampled ${cap} taps` : 'full taps'
      if (sigma === 32) save(`dir-${cap ? 'undersampled' : 'full'}-s32`, out)
      const m = { sigma, mean_err: +meanAbs(out, ref).toFixed(2), max_err: maxAbs(out, ref) }
      const flaws: string[] = []
      if (m.mean_err > 2) flaws.push(`shape ${m.mean_err} codes off ideal`)
      if (m.max_err > 16) flaws.push(`worst-case ${m.max_err} codes off ideal`)
      rows.push({ category: 'directional', variant: `${label} @ sigma ${sigma}`, taps: countTaps(passes), passes: passes.length, metrics: m, flaws })
    }
  }
  notes.push(
    'Directional blur is a single 1D pass, so its cost is O(sigma) rather than O(sigma^2) — ' +
    'at sigma 32 it needs ~259 taps against ~518 for a separable isotropic blur of the same width, ' +
    'and it needs no pyramid to stay affordable.',
  )
}

// ---------------------------------------------------------------------------
// Radial (zoom / spin) — judged on artifacts, no closed-form CPU reference
// ---------------------------------------------------------------------------
async function radial(rig: Rig) {
  const SIZE = 384
  const src = hfNoise(SIZE, SIZE, 33)
  const edge = stepEdge(SIZE, SIZE)
  for (const mode of ['zoom', 'spin'] as const) {
    for (const taps of [17, 65]) {
      const passes = bracket([radialPass(B, 40, mode, taps)])
      const out = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: src, passes, center: [0.5, 0.5] })
      const edgeOut = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: edge, passes, center: [0.5, 0.5] })
      save(`radial-${mode}-${taps}taps`, out)
      // Ghosting from too few taps shows up as structure the ideal would not have:
      // measure how much the result still varies at high frequency relative to a
      // heavily-tapped version of the same effect.
      const stepping = +transitionStepping(out).toFixed(2)
      const ring = +ringingScore(decodeToLinear(edgeOut), decodeToLinear(edge)).toFixed(4)
      const flaws: string[] = []
      if (taps === 17) flaws.push('reference point: deliberately undersampled')
      rows.push({
        category: `radial-${mode}`, variant: `${taps} taps`, taps: countTaps(passes), passes: passes.length,
        metrics: { stepping, ringing: ring }, flaws,
      })
    }
  }
  notes.push(
    'Radial blur has no simple CPU ground truth (the kernel direction varies per pixel), so it is judged ' +
    'on artifacts and by eye. Its distinctive risk is that sample spacing grows with distance from the ' +
    'centre, so a fixed tap count that looks clean near the centre ghosts at the edges — the tap count has ' +
    'to scale with the radius in pixels at the far corner, not with a nominal strength.',
  )
}

// ---------------------------------------------------------------------------
// Bokeh — shape fidelity against a true disc, plus the HDR requirement
// ---------------------------------------------------------------------------
async function bokeh(rig: Rig) {
  const SIZE = 256
  const R = 16
  const SRC_R = 4
  /**
   * The source is a small bright DISC, not a single pixel. A sparse gather's
   * response to one pixel is just its tap pattern — 64 isolated dots — so a
   * single-pixel impulse measures the sampling pattern rather than the aperture
   * shape, and reports every candidate as "not flat-topped". A few-pixel
   * highlight is also what bokeh actually renders in practice.
   */
  const brightDisc = (size: number, r: number): Rgba8 => {
    const img: Rgba8 = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) }
    const c = (size - 1) / 2
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        const v = (x - c) ** 2 + (y - c) ** 2 <= r * r ? 255 : 0
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v
        img.data[i + 3] = 255
      }
    return img
  }
  /** Field of small bright discs — the realistic bokeh subject. */
  const discField = (size: number, count: number, r: number): Rgba8 => {
    const img: Rgba8 = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) }
    for (let p = 0; p < size * size; p++) img.data[p * 4 + 3] = 255
    const step = Math.floor(size / (count + 1))
    for (let gy = 1; gy <= count; gy++)
      for (let gx = 1; gx <= count; gx++) {
        const cx = gx * step
        const cy = gy * step
        for (let y = -r; y <= r; y++)
          for (let x = -r; x <= r; x++) {
            if (x * x + y * y > r * r) continue
            const px = cx + x
            const py = cy + y
            if (px < 0 || py < 0 || px >= size || py >= size) continue
            const i = (py * size + px) * 4
            img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
          }
      }
    return img
  }

  const impulse = brightDisc(SIZE, SRC_R)
  const field = discField(SIZE, 5, 3)
  save('bokeh-source-field', field)
  save('bokeh-source-highlight', impulse)
  void pointOnBlack
  void brightPointField

  const discRef = encodeToSrgb8(discBlur(decodeToLinear(impulse), R, { premultiplied: true }))
  save('bokeh-reference-disc', discRef)

  // Measuring an impulse response needs care: spread over a radius-18 aperture a
  // single bright pixel has amplitude ~1/1017, which quantizes to zero in an
  // 8-bit intermediate long before it can be measured. So the shape run uses
  // float16 intermediates and amplifies just before the 8-bit write. Ratios are
  // unaffected by the gain, which is all the flat-top test needs.
  // Response amplitude inside the aperture is ~ (source area / aperture area),
  // so scale by the inverse of that ratio to land the peak near 0.8.
  const AMPLIFY = Math.max(1, Math.round(0.8 * (R / SRC_R) ** 2))
  const shapeBracket = (k: PassSpec[]): PassSpec[] => {
    const passes = [ingestPass(B), ...k, { body: `return sampleSrc(uv) * ${AMPLIFY.toFixed(1)};`, filter: 'nearest' as const }, egressPass(B)]
    for (let i = 0; i < passes.length - 1; i++) passes[i].float16 = true
    return passes
  }

  const kernelsFor: Array<{ id: string; kernels: PassSpec[] }> = [
    { id: 'disc-gather-64', kernels: [discGatherPass(B, R, 64)] },
    { id: 'disc-gather-256', kernels: [discGatherPass(B, R, 256)] },
    {
      id: 'separable-hexagon',
      kernels: [skewedBoxPass(B, R, 90, 24), skewedBoxPass(B, R, 210, 24), skewedBoxPass(B, R, 330, 24)],
    },
    // a Gaussian of comparable width, to show it cannot produce an aperture shape
    { id: 'gaussian-lookalike', kernels: [linearSampledGaussPass(B, R / 2, 'h'), linearSampledGaussPass(B, R / 2, 'v')] },
  ]
  const variants = kernelsFor.map((v) => ({ id: v.id, passes: bracket(v.kernels), shapePasses: shapeBracket(v.kernels) }))

  for (const v of variants) {
    const out = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: impulse, passes: v.shapePasses })
    save(`bokeh-impulse-${v.id}`, out)
    const fieldOut = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: field, passes: v.passes })
    save(`bokeh-field-${v.id}`, fieldOut)

    // Flat-top test: the ratio of the value at 60% of the radius to the centre.
    // A disc is ~1.0 there; a Gaussian has already fallen well below.
    const c = Math.floor(SIZE / 2)
    const at = (dx: number) => out.data[(c * SIZE + c + dx) * 4]
    // 0.6R is inside the flat region (R - source radius); 1.4R is safely outside
    // the aperture plus the source's own width.
    const flatness = at(0) > 0 ? +(at(Math.round(R * 0.6)) / at(0)).toFixed(3) : 0
    const edgeFall = at(0) > 0 ? +(at(Math.round(R * 1.4)) / at(0)).toFixed(3) : 0
    const m = { centre_value: at(0), flat_top_ratio: flatness, outside_ratio: edgeFall }
    const flaws: string[] = []
    if (at(0) < 16) flaws.push(`impulse response too dim to judge (centre ${at(0)}) — measurement, not the algorithm`)
    else {
      if (flatness < 0.75) flaws.push(`not flat-topped (${flatness} at 60% radius) — reads as a Gaussian smudge, not an aperture`)
      if (edgeFall > 0.25) flaws.push(`soft edge (${edgeFall} beyond the radius)`)
    }
    void discRef
    rows.push({ category: 'bokeh', variant: v.id, taps: countTaps(v.passes), passes: v.passes.length, metrics: m, flaws })
  }

  notes.push(
    'Phase 2 E3b applies directly here: bokeh highlights are the case where an 8-bit pass boundary ' +
    'destroys the effect, clipping the bright cores that make discs read as light sources. A bokeh worth ' +
    'shipping needs float16 intermediates; the isotropic soften blur does not.',
  )
}

// ---------------------------------------------------------------------------
// Progressive / spatially varying
// ---------------------------------------------------------------------------
async function progressive(rig: Rig) {
  const SIZE = 384
  // A mid-grey field with fine detail shows the hand-off between levels clearly.
  const src = hfNoise(SIZE, SIZE, 44)
  save('prog-source', src)

  const configs: Array<{ levels: number; shaping: 'linear' | 'quadratic' }> = [
    { levels: 4, shaping: 'linear' },
    { levels: 8, shaping: 'linear' },
    { levels: 4, shaping: 'quadratic' },
    { levels: 8, shaping: 'quadratic' },
    { levels: 12, shaping: 'quadratic' },
  ]
  for (const { levels, shaping } of configs) {
    const kernels: PassSpec[] = []
    for (let l = 0; l < levels; l++) {
      kernels.push(progressiveStepPass(B, 4, 'h', l, levels, shaping))
      kernels.push(progressiveStepPass(B, 4, 'v', l, levels, shaping))
    }
    const passes = bracket(kernels)
    const out = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: src, passes })
    save(`prog-${levels}levels-${shaping}`, out)

    // Score kinks in the blur-AMOUNT profile (per-column vertical detail energy),
    // not curvature of the image itself — on detailed content the image's own
    // curvature swamps the level hand-off entirely.
    const stepping = rampSteppingScore(out)
    const prof = blurRampProfile(out)
    const m = {
      levels,
      stepping: +stepping.toFixed(2),
      sharp_end_detail: +prof[Math.floor(SIZE * 0.02)].toFixed(2),
      blurred_end_detail: +prof[Math.floor(SIZE * 0.98)].toFixed(2),
    }
    const flaws: string[] = []
    if (stepping > 12) flaws.push(`visible hand-off between blur levels (stepping ${stepping.toFixed(2)})`)
    rows.push({
      category: 'progressive', variant: `${levels} levels, ${shaping} mask`,
      taps: countTaps(passes), passes: passes.length, metrics: m, flaws,
    })
  }

  notes.push(
    'Progressive blur is built by stacking levels and blending per pixel, so the number of levels is the ' +
    'quality knob: too few and the boundary where one level hands over to the next becomes visible. It is ' +
    'also the category that most wants the pyramid, since each level is a fresh blur of the whole frame.',
  )
}

// ---------------------------------------------------------------------------
async function main() {
  const rig = await createRig()
  try {
    console.log('directional...'); await directional(rig)
    console.log('radial...'); await radial(rig)
    console.log('bokeh...'); await bokeh(rig)
    console.log('progressive...'); await progressive(rig)
  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase3c.json'), JSON.stringify({ rows, notes }, null, 2))

  const md: string[] = ['# Phase 3c — directional, radial, bokeh, progressive', '']
  const cats = [...new Set(rows.map((r) => r.category))]
  for (const cat of cats) {
    md.push(`## ${cat}`, '', '| variant | passes | taps | metrics | verdict |', '| --- | --- | --- | --- | --- |')
    for (const r of rows.filter((x) => x.category === cat)) {
      const mm = Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(', ')
      md.push(`| ${r.variant} | ${r.passes} | ${r.taps} | ${mm} | ${r.flaws.length ? '**' + r.flaws.join('; ') + '**' : 'clean'} |`)
    }
    md.push('')
  }
  md.push('## Notes', '', ...notes.map((n) => `- ${n}`), '')
  fs.writeFileSync(path.join(OUT_DIR, 'phase3c.md'), md.join('\n'))

  for (const r of rows) {
    console.log(`  ${r.category.padEnd(16)} ${r.variant.padEnd(28)} ${r.flaws.length ? 'FLAW: ' + r.flaws[0] : 'clean'}`)
  }
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase3c.md')}`)
}

main()
