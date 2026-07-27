/**
 * Phase 2 — isolate the pipeline variables.
 *
 * Before ranking algorithms we need to know how much of "flawless" is decided by
 * the pipeline rather than the algorithm. Four controlled experiments, each
 * changing exactly one thing against the same separable-Gaussian control:
 *
 *   E1 color space  — averaging gamma-encoded sRGB vs linear light
 *   E2 alpha        — straight vs premultiplied convolution at a transparent edge
 *   E3 precision    — 8-bit vs 8-bit+dither vs float16 intermediates, vs pass count
 *   E4 downscale    — full-res wide blur vs a downsample/upsample pyramid
 *
 * Output: reports/blur-bakeoff/phase2.{json,md} plus PNG proof images.
 * Run: npx tsx scripts/blur-bakeoff/phase2-pipeline.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Rig, type Backend } from './lib/gpu-rig'
import { separableGaussianPasses, passthroughPass } from './lib/shaders'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './lib/image'
import { srgbToLinear } from './lib/color'
import { gaussianBlur } from './lib/reference'
import { bandingScore } from './lib/detectors'
import { encodePng } from './lib/png'
import { stepEdge, smoothGradient, transparentEdgeSprite } from './lib/corpus'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase2')
const BACKEND: Backend = 'webgpu'

interface Finding {
  id: string
  title: string
  metrics: Record<string, number | string>
  verdict: string
}
const findings: Finding[] = []

function save(name: string, img: Rgba8): string {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  const p = path.join(IMG_DIR, `${name}.png`)
  fs.writeFileSync(p, encodePng(img))
  return p
}

/** Mean linear-light luminance — the physically meaningful "amount of light". */
function meanLinearLuma(img: Rgba8): number {
  let sum = 0
  const n = img.width * img.height
  for (let p = 0; p < n; p++) {
    const r = srgbToLinear(img.data[p * 4] / 255)
    const g = srgbToLinear(img.data[p * 4 + 1] / 255)
    const b = srgbToLinear(img.data[p * 4 + 2] / 255)
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  return sum / n
}

function meanAbsDiff(a: Rgba8, b: Rgba8): number {
  let sum = 0
  let n = 0
  for (let p = 0; p < a.width * a.height; p++)
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c])
      n++
    }
  return sum / n
}

// ---------------------------------------------------------------------------
// E1 — color space
// ---------------------------------------------------------------------------
async function e1ColorSpace(rig: Rig) {
  const SIZE = 128
  const SIGMA = 12
  const src = stepEdge(SIZE, 32)

  const naive = await rig.capture({
    backend: BACKEND, width: SIZE, height: 32, input: src,
    passes: separableGaussianPasses({ backend: BACKEND, sigma: SIGMA, linearize: false, premultiply: false, float16: true }),
  })
  const linear = await rig.capture({
    backend: BACKEND, width: SIZE, height: 32, input: src,
    passes: separableGaussianPasses({ backend: BACKEND, sigma: SIGMA, linearize: true, premultiply: false, float16: true }),
  })
  const reference = encodeToSrgb8(gaussianBlur(decodeToLinear(src), SIGMA))

  // The midpoint of a blurred black/white edge should carry half the LIGHT,
  // i.e. linear 0.5 -> sRGB ~188. Naive sRGB averaging lands near 128.
  const midX = SIZE / 2
  const row = 16
  const sampleMid = (img: Rgba8) => img.data[(row * img.width + midX) * 4]

  const srcLuma = meanLinearLuma(src)
  const m = {
    midpoint_naive_srgb: sampleMid(naive),
    midpoint_linear_srgb: sampleMid(linear),
    midpoint_reference_srgb: sampleMid(reference),
    mean_linear_luma_source: +srcLuma.toFixed(5),
    mean_linear_luma_naive: +meanLinearLuma(naive).toFixed(5),
    mean_linear_luma_linear: +meanLinearLuma(linear).toFixed(5),
    light_lost_naive_pct: +(((srcLuma - meanLinearLuma(naive)) / srcLuma) * 100).toFixed(2),
    light_lost_linear_pct: +(((srcLuma - meanLinearLuma(linear)) / srcLuma) * 100).toFixed(2),
    mean_abs_diff_naive_vs_ref: +meanAbsDiff(naive, reference).toFixed(2),
    mean_abs_diff_linear_vs_ref: +meanAbsDiff(linear, reference).toFixed(2),
  }
  save('e1-source', src)
  save('e1-naive-srgb', naive)
  save('e1-linearized', linear)
  save('e1-reference', reference)

  findings.push({
    id: 'E1',
    title: 'Color space: averaging must happen in linear light',
    metrics: m,
    verdict:
      `Averaging gamma-encoded values puts the blurred edge midpoint at sRGB ${m.midpoint_naive_srgb} ` +
      `instead of ${m.midpoint_reference_srgb}, and destroys ${m.light_lost_naive_pct}% of the scene's light ` +
      `(linearized: ${m.light_lost_linear_pct}%). Mean error against the reference is ` +
      `${m.mean_abs_diff_naive_vs_ref} codes naive vs ${m.mean_abs_diff_linear_vs_ref} linearized. ` +
      `The engine provides no color management, so a flawless blur MUST linearize itself.`,
  })
}

// ---------------------------------------------------------------------------
// E2 — alpha
// ---------------------------------------------------------------------------
async function e2Alpha(rig: Rig) {
  const SIZE = 96
  const SIGMA = 6
  const src = transparentEdgeSprite(SIZE, SIZE)

  const straight = await rig.capture({
    backend: BACKEND, width: SIZE, height: SIZE, input: src,
    passes: separableGaussianPasses({ backend: BACKEND, sigma: SIGMA, linearize: true, premultiply: false, float16: true }),
  })
  const premult = await rig.capture({
    backend: BACKEND, width: SIZE, height: SIZE, input: src,
    passes: separableGaussianPasses({ backend: BACKEND, sigma: SIGMA, linearize: true, premultiply: true, float16: true }),
  })

  // The field is transparent GREEN; the disc is opaque RED. Any green appearing
  // in pixels that are substantially opaque is colour leaking out of fully
  // transparent texels — the fringe a straight-alpha blur invents.
  const contamination = (img: Rgba8) => {
    let worst = 0
    let sum = 0
    let n = 0
    for (let p = 0; p < SIZE * SIZE; p++) {
      const a = img.data[p * 4 + 3]
      if (a < 200) continue // only judge pixels that are visibly opaque
      const g = img.data[p * 4 + 1]
      const r = img.data[p * 4]
      const leak = Math.max(0, g - Math.max(r * 0.35, 40)) // green beyond the disc's own hue
      if (leak > worst) worst = leak
      sum += leak
      n++
    }
    return { worst, mean: n ? sum / n : 0 }
  }
  const cs = contamination(straight)
  const cp = contamination(premult)

  save('e2-source', src)
  save('e2-straight-alpha', straight)
  save('e2-premultiplied', premult)

  const m = {
    green_leak_worst_straight: +cs.worst.toFixed(1),
    green_leak_mean_straight: +cs.mean.toFixed(2),
    green_leak_worst_premultiplied: +cp.worst.toFixed(1),
    green_leak_mean_premultiplied: +cp.mean.toFixed(2),
  }
  findings.push({
    id: 'E2',
    title: 'Alpha: convolution must be premultiplied',
    metrics: m,
    verdict:
      `Blurring straight-alpha texels drags colour out of fully transparent pixels: worst-case green leak ` +
      `${m.green_leak_worst_straight}/255 (mean ${m.green_leak_mean_straight}) versus ` +
      `${m.green_leak_worst_premultiplied} (mean ${m.green_leak_mean_premultiplied}) when premultiplied. ` +
      `Image texels are uploaded straight, so a flawless blur must premultiply, blur, then un-premultiply — ` +
      `while still passing alpha through per the repo's "don't invent alpha" rule.`,
  })
}

// ---------------------------------------------------------------------------
// E3 — precision / banding vs pass count
// ---------------------------------------------------------------------------
async function e3Precision(rig: Rig) {
  const W = 256
  const H = 48
  // A very low-contrast ramp is the classic banding provocation.
  const src = smoothGradient(W, H, { from: 108, to: 124 })

  interface Row { label: string; chain: number; passes: number; banding: number; err: number }
  const rows: Row[] = []
  const STAGE_SIGMA = 4

  // Two questions are deliberately separated here:
  //   banding — structure visible in the OUTPUT, which is always 8-bit
  //   err     — drift from the correct answer, which is where intermediate
  //             precision actually shows up, so each chain is compared against
  //             the reference for ITS total sigma (s*sqrt(k)), not a fixed one.
  for (const chain of [1, 2, 4, 8]) {
    const totalSigma = STAGE_SIGMA * Math.sqrt(chain)
    const ref = encodeToSrgb8(gaussianBlur(decodeToLinear(src), totalSigma))
    if (chain === 8) save('e3-reference-8chain', ref)

    for (const mode of ['8bit', '8bit+dither', 'float16-linear'] as const) {
      const passes = []
      for (let k = 0; k < chain; k++) {
        passes.push(
          ...separableGaussianPasses({
            backend: BACKEND,
            sigma: STAGE_SIGMA,
            linearize: true,
            premultiply: false,
            dither: mode === '8bit+dither',
            float16: mode === 'float16-linear',
            // A float16 target should hold LINEAR light; re-encoding to sRGB at
            // every boundary would throw away the precision it was allocated for.
            linearIntermediate: mode === 'float16-linear',
          }),
        )
      }
      if (mode === 'float16-linear') for (let i = 0; i < passes.length - 1; i++) passes[i].float16 = true

      const out = await rig.capture({ backend: BACKEND, width: W, height: H, input: src, passes })
      rows.push({
        label: mode,
        chain,
        passes: passes.length,
        banding: +bandingScore(out).toFixed(3),
        err: +meanAbsDiff(out, ref).toFixed(3),
      })
      if (chain === 8) save(`e3-${mode.replace(/\+/g, '-')}-${passes.length}pass`, out)
    }
  }
  save('e3-source', src)

  const pick = (label: string, chain: number) => rows.find((r) => r.label === label && r.chain === chain)!
  const deepest = 8
  const m: Record<string, number | string> = {
    source_banding: +bandingScore(src).toFixed(3),
    banding_8bit: pick('8bit', deepest).banding,
    'banding_8bit+dither': pick('8bit+dither', deepest).banding,
    banding_float16: pick('float16-linear', deepest).banding,
    err_8bit_1chain: pick('8bit', 1).err,
    err_8bit_8chain: pick('8bit', deepest).err,
    err_float16_1chain: pick('float16-linear', 1).err,
    err_float16_8chain: pick('float16-linear', deepest).err,
    'err_8bit+dither_8chain': pick('8bit+dither', deepest).err,
    detail: rows.map((r) => `${r.label}@${r.passes}p banding=${r.banding} err=${r.err}`).join('; '),
  }

  const err8 = pick('8bit', deepest).err
  const errF = pick('float16-linear', deepest).err
  findings.push({
    id: 'E3',
    title: 'Precision: banding is an OUTPUT problem that dither fixes, not an intermediate-precision problem',
    metrics: m,
    verdict:
      `(1) Visible banding is a property of the final 8-bit write, not of intermediate precision: mean ` +
      `plateau length is ${m.banding_8bit} with 8-bit intermediates and ${m.banding_float16} with float16 — ` +
      `no improvement — while one LSB of dither collapses it to ${m['banding_8bit+dither']}. ` +
      `Dither is the fix for banding; float16 is not. ` +
      `(2) Contrary to expectation, 8-bit intermediates did NOT accumulate meaningful drift on LDR content: ` +
      `even over a 16-pass chain both stayed well under half a code (8-bit ${err8}, float16 ${errF}). ` +
      `The float16 figure is the larger one, but neither is visible, and the comparison is not diagnostic — ` +
      `a linear ramp is nearly unchanged by a symmetric blur away from its borders, so 8-bit storage rounds ` +
      `back onto the source's own integer grid and flatters itself. The honest reading is that for ordinary ` +
      `LDR blur, 8-bit intermediates are adequate and dither matters far more. See E3b for the case where ` +
      `precision genuinely decides the result. Note dither raises numeric error ` +
      `(${m['err_8bit+dither_8chain']} codes) while removing visible structure — the metric is a screen, ` +
      `the eye is the judge.`,
  })
}

// ---------------------------------------------------------------------------
// E3b — where precision actually decides: HDR headroom above 1.0
// ---------------------------------------------------------------------------
async function e3bHdrHeadroom(rig: Rig) {
  const SIZE = 96
  const SIGMA = 6
  const GAIN = 4 // a highlight 4x brighter than display white
  // A LARGE bright region, not a single pixel: a lone bright pixel blurred at
  // sigma 6 peaks near 0.53 even after an 8x gain, so nothing would ever clip
  // and the experiment would report a false negative. A wide disc keeps its
  // interior at full intensity through the blur, which is what exposes clipping.
  const src: Rgba8 = { width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) }
  {
    const c = (SIZE - 1) / 2
    const r = SIZE * 0.33
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4
        const v = (x - c) ** 2 + (y - c) ** 2 <= r * r ? 255 : 0
        src.data[i] = src.data[i + 1] = src.data[i + 2] = v
        src.data[i + 3] = 255
      }
  }

  // Gain up in linear light, blur, then gain back down. Mathematically the gain
  // cancels, so the correct answer is just a plain linear-light blur. An 8-bit
  // unorm intermediate cannot hold the >1.0 values and clips them away.
  const build = (float16: boolean) => {
    const passes = separableGaussianPasses({
      backend: BACKEND, sigma: SIGMA, linearize: true, premultiply: false,
      float16, linearIntermediate: true, preScale: GAIN,
    })
    // undo the gain in the final pass only
    const last = separableGaussianPasses({
      backend: BACKEND, sigma: SIGMA, linearize: true, premultiply: false,
      linearIntermediate: true, postScale: GAIN,
    })[1]
    return [passes[0], last]
  }

  const clipped = await rig.capture({ backend: BACKEND, width: SIZE, height: SIZE, input: src, passes: build(false) })
  const kept = await rig.capture({ backend: BACKEND, width: SIZE, height: SIZE, input: src, passes: build(true) })
  const reference = encodeToSrgb8(gaussianBlur(decodeToLinear(src), SIGMA))

  save('e3b-source', src)
  save('e3b-8bit-clipped', clipped)
  save('e3b-float16-kept', kept)
  save('e3b-reference', reference)

  const energy = (img: Rgba8) => meanLinearLuma(img) * img.width * img.height
  const eRef = energy(reference)
  const centre = (img: Rgba8) => img.data[(Math.floor(SIZE / 2) * img.width + Math.floor(SIZE / 2)) * 4]
  const m = {
    gain: GAIN,
    disc_centre_reference_srgb: centre(reference),
    disc_centre_8bit_srgb: centre(clipped),
    disc_centre_float16_srgb: centre(kept),
    total_light_reference: +eRef.toFixed(4),
    total_light_8bit: +energy(clipped).toFixed(4),
    total_light_float16: +energy(kept).toFixed(4),
    light_lost_8bit_pct: +(((eRef - energy(clipped)) / eRef) * 100).toFixed(2),
    light_lost_float16_pct: +(((eRef - energy(kept)) / eRef) * 100).toFixed(2),
    mean_abs_diff_8bit_vs_ref: +meanAbsDiff(clipped, reference).toFixed(2),
    mean_abs_diff_float16_vs_ref: +meanAbsDiff(kept, reference).toFixed(2),
  }
  findings.push({
    id: 'E3b',
    title: 'Precision: float16 intermediates are required only once values exceed 1.0',
    metrics: m,
    verdict:
      `Blurring a ${GAIN}x-bright disc, an rgba8unorm intermediate clips everything above display white: ` +
      `the disc centre comes back at sRGB ${m.disc_centre_8bit_srgb} instead of ` +
      `${m.disc_centre_reference_srgb}, losing ${m.light_lost_8bit_pct}% of the scene's light, ` +
      `${m.mean_abs_diff_8bit_vs_ref} codes from the reference. float16 holds it exactly ` +
      `(centre ${m.disc_centre_float16_srgb}, ${m.light_lost_float16_pct}% lost, ` +
      `${m.mean_abs_diff_float16_vs_ref} codes). This is the real case for float16: not banding and not LDR ` +
      `drift, but any pass boundary that must carry values above 1.0 — bloom, and bokeh highlights in ` +
      `particular. An LDR soften blur does not need it; a bokeh with bright discs does. Worth noting the ` +
      `blur itself does not create these values: any upstream node (brightness, multiply) can, and every ` +
      `8-bit pass boundary silently clamps them.`,
  })
}

// ---------------------------------------------------------------------------
// E4 — downscale pyramid
// ---------------------------------------------------------------------------
async function e4Downscale(rig: Rig) {
  const SIZE = 256
  const SIGMA = 24 // wide blur: this is where cost explodes at full res
  const src = smoothGradient(SIZE, SIZE, { from: 20, to: 235 })
  const reference = encodeToSrgb8(gaussianBlur(decodeToLinear(src), SIGMA))

  // (a) full resolution, full kernel
  const fullPasses = separableGaussianPasses({
    backend: BACKEND, sigma: SIGMA, linearize: true, premultiply: false, float16: true,
  })
  const full = await rig.capture({ backend: BACKEND, width: SIZE, height: SIZE, input: src, passes: fullPasses })
  const fullTaps = countTaps(fullPasses.map((p) => p.body))

  // (b) quarter-resolution pyramid: downsample, blur small, upsample
  const scale = 0.25
  const smallPasses = separableGaussianPasses({
    backend: BACKEND, sigma: SIGMA * scale, linearize: true, premultiply: false, float16: true,
  })
  const pyramid = [
    { ...passthroughPass('linear'), scale }, // downsample
    { ...smallPasses[0], scale },
    { ...smallPasses[1], scale },
    { ...passthroughPass('linear'), scale: 1 }, // upsample
  ]
  const pyr = await rig.capture({ backend: BACKEND, width: SIZE, height: SIZE, input: src, passes: pyramid })
  const pyrTaps = countTaps(pyramid.map((p) => p.body))

  save('e4-source', src)
  save('e4-reference', reference)
  save('e4-fullres', full)
  save('e4-pyramid-quarter', pyr)

  // Cost proxy: taps actually evaluated, weighted by the pixel count of the pass.
  const fullCost = fullTaps * SIZE * SIZE
  const pyrCost = pyrTaps * SIZE * SIZE * scale * scale

  const m = {
    sigma: SIGMA,
    taps_fullres: fullTaps,
    taps_pyramid: pyrTaps,
    relative_sample_cost: +(fullCost / Math.max(1, pyrCost)).toFixed(1),
    mean_abs_diff_fullres_vs_ref: +meanAbsDiff(full, reference).toFixed(2),
    mean_abs_diff_pyramid_vs_ref: +meanAbsDiff(pyr, reference).toFixed(2),
  }
  findings.push({
    id: 'E4',
    title: 'Downscale: the pyramid is the only affordable route to a wide radius',
    metrics: m,
    verdict:
      `At sigma ${SIGMA} the full-resolution separable kernel needs ${fullTaps} taps per pixel; the ` +
      `quarter-resolution pyramid needs ${pyrTaps} on 1/16 of the pixels — roughly ` +
      `${m.relative_sample_cost}x less sampling work — while landing ${m.mean_abs_diff_pyramid_vs_ref} codes ` +
      `from the reference versus ${m.mean_abs_diff_fullres_vs_ref} for full-res. The engine allocates every ` +
      `intermediate at full canvas size, so this cannot be expressed today without adding per-pass resolution.`,
  })
}

function countTaps(bodies: string[]): number {
  return bodies.reduce((n, b) => n + (b.match(/sampleSrc\(/g)?.length ?? 0), 0)
}

// ---------------------------------------------------------------------------
async function main() {
  const rig = await createRig()
  if (!rig.available.webgpu) {
    console.error('WebGPU unavailable — cannot run Phase 2')
    await rig.close()
    process.exit(1)
  }
  try {
    console.log('E1 color space...'); await e1ColorSpace(rig)
    console.log('E2 alpha...'); await e2Alpha(rig)
    console.log('E3 precision...'); await e3Precision(rig)
    console.log('E3b HDR headroom...'); await e3bHdrHeadroom(rig)
    console.log('E4 downscale...'); await e4Downscale(rig)
  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase2.json'), JSON.stringify({ backend: BACKEND, findings }, null, 2))

  const md: string[] = [
    '# Phase 2 — pipeline variable isolation',
    '',
    `Backend: \`${BACKEND}\`. Each experiment changes one variable against the same`,
    'separable-Gaussian control, so a flaw can be attributed to the pipeline rather',
    'than to an algorithm. Proof images in `phase2/`.',
    '',
  ]
  for (const f of findings) {
    md.push(`## ${f.id} — ${f.title}`, '')
    md.push('| metric | value |', '| --- | --- |')
    for (const [k, v] of Object.entries(f.metrics)) md.push(`| ${k} | ${v} |`)
    md.push('', f.verdict, '')
  }
  fs.writeFileSync(path.join(OUT_DIR, 'phase2.md'), md.join('\n'))

  console.log('\n' + findings.map((f) => `${f.id}: ${f.verdict}`).join('\n\n'))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase2.md')}`)
}

main()
