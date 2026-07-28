/**
 * Phase 9a — establish, from real images, what a frosted-glass scatter is
 * SUPPOSED to look like, and pin down the known-bad anchor.
 *
 * The user's complaint about reeded-glass Frost is that it "looks like
 * pixelation, bit frost, although its application technique looks alright" —
 * WHERE the frost lands is right, the TEXTURE is wrong. Before any candidate
 * replacement is designed, this phase fixes two anchors:
 *
 *   TARGET    — a CONVERGED scatter, computed on CPU in linear light with
 *               premultiplied alpha, at frost half-extents of 6/12/18/24 CSS
 *               px. Three kernel shapes at matched second moment, so "kernel
 *               shape" and "tap count" can be told apart.
 *   KNOWN-BAD — the same converged result pushed through a block quantiser
 *               (8x8 device px at DPR 2), to test whether block quantisation
 *               ALONE reproduces the complaint. Plus a faithful CPU replay of
 *               the shipped shader loop, which is what is actually on screen,
 *               plus the lattice-removed ablation that separates the two.
 *
 * Geometry, from src/nodes/transform/reeded-glass.ts:
 *   half-extent  = frost * 24 * u_dpr device px  (frost is 0..1)
 *                  => frost 0.25/0.5/0.75/1.0 = 6/12/18/24 CSS px
 *   seed lattice = floor(rg_coords * u_ref_size*0.25); rg_coords has unit
 *                  u_dpr*512 device px, so one lattice cell is u_dpr*4 device
 *                  px: 4 device px at DPR 1, 8 device px at DPR 2.
 *
 * Images here are DEVICE-pixel rasters. The DPR-2 grid is the headline (that is
 * where the 8x8 block comes from and where the artefact bites hardest); the
 * DPR-1 grid is carried for completeness.
 *
 * Every metric is calibrated against a synthetic known-good AND a synthetic
 * known-bad before a single number from it is trusted (see runCalibration).
 *
 * Run: npx tsx scripts/blur-bakeoff/phase9-target.ts
 * Out: reports/blur-bakeoff/phase9/target/*.png
 *      reports/blur-bakeoff/phase9/phase9-target.json
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig } from './lib/gpu-rig'
import { decodeToLinear, encodeToSrgb8, createFloat, type Rgba8, type FloatImage } from './lib/image'
import { encodePng } from './lib/png'
import { transparentEdgeSprite } from './lib/corpus'
import { discBlur } from './lib/reference2'
import {
  discBlurFast, boxBlurUniform, gaussianMatched, sigmaForDisc, sigmaForBox,
  blockQuantize, sparseTapScatter,
} from './lib/frost-kernels'
import {
  deviation, blockEdgeExcess, blockCoherence, speckleRms, directionalCorr, insetRoi, type Roi,
} from './lib/frost-metrics'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase9')
const IMG_DIR = path.join(OUT_DIR, 'target')

const SIZE = 512                      // device px
const R_CSS = [6, 12, 18, 24]         // frost half-extents in CSS px (frost 0.25..1.0)
const PNG_RADII = new Set([12, 24])   // full-size PNGs only at these radii (disk budget)
const PREMULT = { premultiplied: true }

interface Stim { name: string; note: string; img: Rgba8 }

const files: string[] = []

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  const p = path.join(IMG_DIR, `${name}.png`)
  fs.writeFileSync(p, encodePng(img))
  files.push(p)
}

function centerCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const cw = Math.min(w, img.width)
  const ch = Math.min(h, img.height)
  const x0 = Math.floor((img.width - cw) / 2)
  const y0 = Math.floor((img.height - ch) / 2)
  const out: Rgba8 = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      for (let c = 0; c < 4; c++)
        out.data[(y * cw + x) * 4 + c] = img.data[((y + y0) * img.width + (x + x0)) * 4 + c]
  return out
}

/** Nearest-neighbour crop-and-zoom, so block structure survives the write-out. */
function cropZoom(img: Rgba8, x0: number, y0: number, w: number, h: number, scale: number): Rgba8 {
  const ow = w * scale, oh = h * scale
  const out: Rgba8 = { width: ow, height: oh, data: new Uint8ClampedArray(ow * oh * 4) }
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(img.width - 1, x0 + Math.floor(x / scale))
      const sy = Math.min(img.height - 1, y0 + Math.floor(y / scale))
      for (let c = 0; c < 4; c++) out.data[(y * ow + x) * 4 + c] = img.data[(sy * img.width + sx) * 4 + c]
    }
  return out
}

/** Tile images left-to-right on a dark background with a gap. */
function montage(tiles: Rgba8[], gap = 8): Rgba8 {
  const h = Math.max(...tiles.map((t) => t.height))
  const w = tiles.reduce((s, t) => s + t.width, 0) + gap * (tiles.length - 1)
  const out: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 24; out.data[i + 1] = 24; out.data[i + 2] = 32; out.data[i + 3] = 255
  }
  let ox = 0
  for (const t of tiles) {
    for (let y = 0; y < t.height; y++)
      for (let x = 0; x < t.width; x++)
        for (let c = 0; c < 4; c++)
          out.data[(y * w + (x + ox)) * 4 + c] = t.data[(y * t.width + x) * 4 + c]
    ox += t.width + gap
  }
  return out
}

function r2(v: number): number { return Math.round(v * 100) / 100 }
function r3(v: number | null): number | null { return v === null ? null : Math.round(v * 1000) / 1000 }
function pad(v: unknown, n: number): string { return String(v).padEnd(n) }
function padL(v: unknown, n: number): string { return String(v).padStart(n) }

// ---------------------------------------------------------------------------
// Metric calibration. Nothing downstream is trusted until this passes.
// ---------------------------------------------------------------------------
interface Gate { id: string; expect: string; value: number | string | null; pass: boolean }
interface CalibRow {
  image: string
  blockEdge_across: number; blockEdge_within: number; blockEdge_excess: number
  coherence_within: number | null; coherence_across: number | null; coherence_drop: number | null
  speckle_rms: number
}

function runCalibration(baseFloat: FloatImage): { gates: Gate[]; rows: CalibRow[] } {
  const gates: Gate[] = []
  const rows: CalibRow[] = []
  const BLOCK = 8

  // --- kernel parity: the fast disc must equal the O(R^2) reference exactly --
  let discMax = 0
  const small = createFloat(64, 64)
  for (let i = 0; i < small.data.length; i++) small.data[i] = Math.random()
  for (const R of [1, 2.5, 6, 12, 17]) {
    const a = discBlur(small, R, PREMULT)
    const b = discBlurFast(small, R, PREMULT)
    for (let i = 0; i < a.data.length; i++) discMax = Math.max(discMax, Math.abs(a.data[i] - b.data[i]))
  }
  gates.push({ id: 'discFast==discRef', expect: 'max|diff| < 1e-6 linear', value: +discMax.toExponential(2), pass: discMax < 1e-6 })

  // --- simulator geometry: a heavily-oversampled sparse scatter must converge
  // onto the analytic kernel of the SAME footprint, and not onto the other one.
  // This validates reedHash's distribution, the jitter scaling and the
  // premultiplied accumulation against a closed-form answer.
  {
    const W = 192
    const crop = createFloat(W, W)
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++)
        for (let c = 0; c < 4; c++)
          crop.data[(y * W + x) * 4 + c] = baseFloat.data[((y + 160) * baseFloat.width + (x + 160)) * 4 + c]
    const R = 16
    const cRoi = insetRoi(W, W, 40)
    const eBox = encodeToSrgb8(boxBlurUniform(crop, R, PREMULT))
    const eDisc = encodeToSrgb8(discBlurFast(crop, R, PREMULT))
    const simSq = encodeToSrgb8(sparseTapScatter(crop, { halfExtentPx: R, taps: 384, seedBlockPx: 0, footprint: 'square' }))
    const simDi = encodeToSrgb8(sparseTapScatter(crop, { halfExtentPx: R, taps: 384, seedBlockPx: 0, footprint: 'disc' }))
    const sqToBox = deviation(simSq, eBox, cRoi).coveredMeanAbs
    const sqToDisc = deviation(simSq, eDisc, cRoi).coveredMeanAbs
    const diToDisc = deviation(simDi, eDisc, cRoi).coveredMeanAbs
    const diToBox = deviation(simDi, eBox, cRoi).coveredMeanAbs
    gates.push({
      id: 'sim/square->box', expect: '384-tap square nearer box than disc',
      value: `${r2(sqToBox)} vs ${r2(sqToDisc)}`, pass: sqToBox < sqToDisc * 0.6,
    })
    gates.push({
      id: 'sim/disc->disc', expect: '384-tap disc nearer disc than box',
      value: `${r2(diToDisc)} vs ${r2(diToBox)}`, pass: diToDisc < diToBox * 0.6,
    })
  }

  // --- four calibration images ----------------------------------------------
  // good : a converged disc scatter at a mid radius. Local gradients are still
  //        strong enough that a block quantiser has something to step on.
  const goodF = discBlurFast(baseFloat, 12, PREMULT)
  const good = encodeToSrgb8(goodF)
  // bad  : the same, averaged onto an 8x8 grid.
  const bad = encodeToSrgb8(blockQuantize(goodF, BLOCK, PREMULT))
  // noisy: good + iid uniform noise, +-12 codes. Grainy but NOT blocky — the
  //        control that proves blockEdgeExcess does not fire on mere grain.
  const noisy: Rgba8 = { width: good.width, height: good.height, data: new Uint8ClampedArray(good.data) }
  for (let i = 0; i < noisy.data.length; i += 4)
    for (let c = 0; c < 3; c++) noisy.data[i + c] = noisy.data[i + c] + (Math.random() * 2 - 1) * 12
  // flat : degenerate input; must not produce NaN or a bogus correlation.
  const flat: Rgba8 = { width: 128, height: 128, data: new Uint8ClampedArray(128 * 128 * 4) }
  for (let i = 0; i < flat.data.length; i += 4) {
    flat.data[i] = flat.data[i + 1] = flat.data[i + 2] = 128; flat.data[i + 3] = 255
  }

  const roi = insetRoi(good.width, good.height, 64)
  const flatRoi = insetRoi(flat.width, flat.height, 8)

  for (const [name, img, r] of [
    ['good_converged_disc_r12', good, roi],
    ['bad_block8_quantised', bad, roi],
    ['ctrl_good_plus_noise12', noisy, roi],
    ['ctrl_flat_grey', flat, flatRoi],
  ] as Array<[string, Rgba8, Roi]>) {
    const be = blockEdgeExcess(img, BLOCK, r)
    const bc = blockCoherence(img, BLOCK, r)
    rows.push({
      image: name,
      blockEdge_across: r2(be.acrossMean), blockEdge_within: r2(be.withinMean), blockEdge_excess: r2(be.excess),
      coherence_within: r3(bc.within), coherence_across: r3(bc.across), coherence_drop: r3(bc.drop),
      speckle_rms: r2(speckleRms(img, r)),
    })
  }
  const [gRow, bRow, nRow, fRow] = rows

  gates.push({ id: 'blockEdge/known-good', expect: '|excess| < 0.5 codes', value: gRow.blockEdge_excess, pass: Math.abs(gRow.blockEdge_excess) < 0.5 })
  gates.push({ id: 'blockEdge/known-bad', expect: 'excess > 2 codes and > 10x good', value: bRow.blockEdge_excess, pass: bRow.blockEdge_excess > 2 && bRow.blockEdge_excess > 10 * Math.max(Math.abs(gRow.blockEdge_excess), 0.01) })
  gates.push({ id: 'blockEdge/grain-not-block', expect: '|excess| < 0.5 on pure grain', value: nRow.blockEdge_excess, pass: Math.abs(nRow.blockEdge_excess) < 0.5 })
  gates.push({ id: 'blockEdge/flat-degenerate', expect: 'excess == 0, finite', value: fRow.blockEdge_excess, pass: fRow.blockEdge_excess === 0 })

  gates.push({ id: 'coherence/known-good', expect: '|drop| < 0.05', value: gRow.coherence_drop, pass: gRow.coherence_drop !== null && Math.abs(gRow.coherence_drop) < 0.05 })
  gates.push({ id: 'coherence/known-bad', expect: 'drop > 0.30', value: bRow.coherence_drop, pass: bRow.coherence_drop !== null && bRow.coherence_drop > 0.3 })
  gates.push({ id: 'coherence/grain-not-block', expect: '|drop| < 0.05 on pure grain', value: nRow.coherence_drop, pass: nRow.coherence_drop !== null && Math.abs(nRow.coherence_drop) < 0.05 })
  gates.push({ id: 'coherence/flat-degenerate', expect: 'null, not NaN', value: fRow.coherence_drop, pass: fRow.coherence_drop === null })

  gates.push({ id: 'speckle/known-good', expect: '< 1.5 codes on converged blur', value: gRow.speckle_rms, pass: gRow.speckle_rms < 1.5 })
  gates.push({ id: 'speckle/known-bad', expect: '> 5 codes on +-12 code grain', value: nRow.speckle_rms, pass: nRow.speckle_rms > 5 })
  gates.push({ id: 'speckle/flat-degenerate', expect: '== 0, finite', value: fRow.speckle_rms, pass: fRow.speckle_rms === 0 })

  // --- directional correlation: white vs deliberately oriented grain --------
  {
    const W = 256
    const white: Rgba8 = { width: W, height: W, data: new Uint8ClampedArray(W * W * 4) }
    const diag: Rgba8 = { width: W, height: W, data: new Uint8ClampedArray(W * W * 4) }
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const wv = 128 + (Math.random() * 2 - 1) * 40
        // known-bad: value depends only on (x+y), so 135deg is perfectly
        // correlated and 45deg is not — a pure orientation artefact.
        const dv = 128 + (((x + y) % 7) - 3) * 13
        white.data[i] = white.data[i + 1] = white.data[i + 2] = wv
        diag.data[i] = diag.data[i + 1] = diag.data[i + 2] = dv
        white.data[i + 3] = diag.data[i + 3] = 255
      }
    const dRoi = insetRoi(W, W, 16)
    const dWhite = directionalCorr(white, dRoi)
    const dDiag = directionalCorr(diag, dRoi)
    gates.push({ id: 'dirCorr/white-noise', expect: 'anisotropy < 0.05', value: r3(dWhite.anisotropy), pass: dWhite.anisotropy !== null && dWhite.anisotropy < 0.05 })
    gates.push({ id: 'dirCorr/oriented', expect: 'anisotropy > 0.5', value: r3(dDiag.anisotropy), pass: dDiag.anisotropy !== null && dDiag.anisotropy > 0.5 })
    const dGood = directionalCorr(good, roi)
    gates.push({ id: 'dirCorr/known-good-image', expect: 'anisotropy < 0.15 on a converged blur', value: r3(dGood.anisotropy), pass: dGood.anisotropy !== null && dGood.anisotropy < 0.15 })
  }

  const self = deviation(good, good, roi)
  gates.push({ id: 'deviation/identity', expect: 'all zero', value: self.maxAbs, pass: self.maxAbs === 0 })
  const dBad = deviation(good, bad, roi)
  gates.push({ id: 'deviation/known-bad', expect: 'mean > 0.5 codes', value: r2(dBad.meanAbs), pass: dBad.meanAbs > 0.5 })

  save('calib-good-converged-disc-r12', good)
  save('calib-bad-block8', bad)
  save('calib-ctrl-noise12', noisy)
  save('calib-zoom-good_bad_noise', montage([
    cropZoom(good, 200, 200, 96, 96, 4),
    cropZoom(bad, 200, 200, 96, 96, 4),
    cropZoom(noisy, 200, 200, 96, 96, 4),
  ]))

  return { gates, rows }
}

// ---------------------------------------------------------------------------

async function loadStimuli(): Promise<Stim[]> {
  const rig = await createRig()
  const out: Stim[] = []
  try {
    const photos: Array<[string, string, number, string]> = [
      ['photo-street', 'stuff/2013-03-12 00.48.07.jpg', 1024, 'photograph, mixed fine detail and smooth regions'],
      ['photo-flickr', 'stuff/5468102179_8f885a1744_o.jpg', 1024, 'second photograph, different content statistics'],
      ['ui-screenshot', 'stuff/Screenshot 2026-06-11 at 15.38.50.png', 0, 'native-resolution UI: hard high-contrast edges and text, worst case for block artefacts'],
    ]
    for (const [name, file, maxDim, note] of photos) {
      const bytes = new Uint8Array(fs.readFileSync(file))
      const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg'
      const dec = await rig.decodeImage(bytes, mime, maxDim || undefined)
      out.push({ name, note, img: centerCrop(dec, SIZE, SIZE) })
    }
  } finally {
    await rig.close()
  }
  // Alpha stimulus: exercises the premultiplied path, so "don't invent alpha"
  // can be checked against a real transparent edge rather than asserted.
  out.push({ name: 'alpha-sprite', note: 'transparent-edge sprite; premultiplied-path check', img: transparentEdgeSprite(SIZE, SIZE) })
  return out
}

async function main() {
  const t0 = Date.now()
  const stims = await loadStimuli()
  const findings: Record<string, unknown> = {}
  for (const s of stims) save(`source-${s.name}`, s.img)

  // --- 0. calibration -------------------------------------------------------
  const calib = runCalibration(decodeToLinear(stims[0].img))
  const failed = calib.gates.filter((g) => !g.pass)
  console.log('\n=== METRIC CALIBRATION ===')
  for (const g of calib.gates) console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  ${pad(g.id, 28)} ${pad(g.expect, 34)} -> ${g.value}`)
  console.log('')
  console.log(`  ${pad('image', 26)}${padL('bAcross', 9)}${padL('bWithin', 9)}${padL('bExcess', 9)}${padL('cohWithin', 11)}${padL('cohAcross', 11)}${padL('cohDrop', 9)}${padL('speckle', 9)}`)
  for (const r of calib.rows)
    console.log(`  ${pad(r.image, 26)}${padL(r.blockEdge_across, 9)}${padL(r.blockEdge_within, 9)}${padL(r.blockEdge_excess, 9)}${padL(r.coherence_within, 11)}${padL(r.coherence_across, 11)}${padL(r.coherence_drop, 9)}${padL(r.speckle_rms, 9)}`)
  if (failed.length) console.log(`\n!!! ${failed.length} CALIBRATION GATE(S) FAILED — numbers below are NOT trustworthy\n`)
  findings.calibration = { gates: calib.gates, rows: calib.rows, allPassed: failed.length === 0 }

  // --- 1. converged targets: kernel shape at matched second moment ----------
  //   disc(R)          uniform disc, radius R device px      (Var = R^2/4)
  //   gauss(R/2)       Gaussian matched to the disc          (Var = R^2/4)
  //   box(R)           uniform square half-extent R          (Var = R^2/3)
  //                    <- the footprint the shipped shader integrates over,
  //                       because reedHash returns vec2 in [-1,1]^2
  //   gaussBox(R/sq3)  Gaussian matched to the box           (Var = R^2/3)
  const shapeRows: Array<Record<string, unknown>> = []
  const discCache = new Map<string, FloatImage>()

  for (const s of stims) {
    const src = decodeToLinear(s.img)
    for (const dpr of [2, 1]) {
      for (const rcss of R_CSS) {
        const R = rcss * dpr // device px
        const roi = insetRoi(SIZE, SIZE, Math.min(200, Math.ceil(R * 1.5) + 8))
        const fDisc = discBlurFast(src, R, PREMULT)
        const fGauss = gaussianMatched(src, sigmaForDisc(R), PREMULT)
        const fBox = boxBlurUniform(src, R, PREMULT)
        const fGaussBox = gaussianMatched(src, sigmaForBox(R), PREMULT)
        discCache.set(`${s.name}|${dpr}|${rcss}`, fDisc)

        const eDisc = encodeToSrgb8(fDisc)
        const eGauss = encodeToSrgb8(fGauss)
        const eBox = encodeToSrgb8(fBox)
        const eGaussBox = encodeToSrgb8(fGaussBox)

        const dSrc = deviation(s.img, eDisc, roi)     // magnitude of the whole effect
        const dShape = deviation(eDisc, eGauss, roi)  // disc vs matched Gaussian
        const dBox = deviation(eDisc, eBox, roi)      // disc vs square footprint
        const dBoxG = deviation(eBox, eGaussBox, roi) // square vs its matched Gaussian

        // Headline numbers are alpha-COVERED (both images opaque enough that
        // straight-alpha RGB is defined). Identical to the unrestricted stats
        // on the three opaque stimuli; only the sprite differs.
        shapeRows.push({
          stim: s.name, dpr, r_css: rcss, r_devpx: R, covered_frac: r2(dShape.coveredFraction),
          effect_mean: r2(dSrc.coveredMeanAbs), effect_max: dSrc.coveredMaxAbs,
          disc_vs_gauss_mean: r2(dShape.coveredMeanAbs), disc_vs_gauss_p99: dShape.coveredP99Abs, disc_vs_gauss_max: dShape.coveredMaxAbs,
          disc_vs_box_mean: r2(dBox.coveredMeanAbs), disc_vs_box_p99: dBox.coveredP99Abs, disc_vs_box_max: dBox.coveredMaxAbs,
          box_vs_gaussbox_mean: r2(dBoxG.coveredMeanAbs), box_vs_gaussbox_max: dBoxG.coveredMaxAbs,
          disc_vs_gauss_alpha_mean: r2(dShape.alphaMeanAbs), disc_vs_gauss_alpha_max: dShape.alphaMaxAbs,
          disc_vs_gauss_mean_allpx: r2(dShape.meanAbs), disc_vs_gauss_max_allpx: dShape.maxAbs,
          speckle_disc: r2(speckleRms(eDisc, roi)), speckle_gauss: r2(speckleRms(eGauss, roi)),
        })

        if (dpr === 2 && PNG_RADII.has(rcss)) {
          save(`${s.name}-dpr2-r${rcss}css-disc`, eDisc)
          save(`${s.name}-dpr2-r${rcss}css-gauss`, eGauss)
          save(`${s.name}-dpr2-r${rcss}css-box`, eBox)
        }
      }
    }
    console.log(`  shapes done: ${s.name}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
  findings.kernelShape = shapeRows

  console.log('\n=== CONVERGED KERNEL SHAPE, 8-bit codes, alpha-covered (mean / p99 / max abs deviation) ===')
  console.log(`  ${pad('stim', 15)}${padL('dpr', 4)}${padL('rCSS', 6)}${padL('rDev', 6)}${padL('cov', 6)}${padL('effect', 9)}${padL('disc-vs-gauss', 20)}${padL('disc-vs-box', 20)}${padL('box-vs-g', 12)}`)
  for (const r of shapeRows)
    console.log(`  ${pad(r.stim, 15)}${padL(r.dpr, 4)}${padL(r.r_css, 6)}${padL(r.r_devpx, 6)}${padL(r.covered_frac, 6)}${padL(r.effect_mean, 9)}${padL(`${r.disc_vs_gauss_mean}/${r.disc_vs_gauss_p99}/${r.disc_vs_gauss_max}`, 20)}${padL(`${r.disc_vs_box_mean}/${r.disc_vs_box_p99}/${r.disc_vs_box_max}`, 20)}${padL(`${r.box_vs_gaussbox_mean}/${r.box_vs_gaussbox_max}`, 12)}`)

  // --- 2. degradations ------------------------------------------------------
  const degRows: Array<Record<string, unknown>> = []
  for (const s of stims) {
    const src = decodeToLinear(s.img)
    for (const dpr of [2, 1]) {
      const block = 4 * dpr // lattice cell in device px
      for (const rcss of R_CSS) {
        const R = rcss * dpr
        const roi = insetRoi(SIZE, SIZE, Math.min(200, Math.ceil(R * 1.5) + 8))
        const fDisc = discCache.get(`${s.name}|${dpr}|${rcss}`)!
        const eDisc = encodeToSrgb8(fDisc)

        const variants: Array<[string, Rgba8]> = [
          ['converged_disc', eDisc],
          ['blockQuant', encodeToSrgb8(blockQuantize(fDisc, block, PREMULT))],
          ['shader_8tap_lattice', encodeToSrgb8(sparseTapScatter(src, { halfExtentPx: R, taps: 8, seedBlockPx: block }))],
          ['ablate_8tap_perpixel', encodeToSrgb8(sparseTapScatter(src, { halfExtentPx: R, taps: 8, seedBlockPx: 0 }))],
        ]
        for (const [variant, img] of variants) {
          const be = blockEdgeExcess(img, block, roi)
          const bc = blockCoherence(img, block, roi)
          const dc = directionalCorr(img, roi)
          const dv = deviation(eDisc, img, roi)
          degRows.push({
            stim: s.name, dpr, r_css: rcss, block_devpx: block, variant,
            vs_target_mean: r2(dv.coveredMeanAbs), vs_target_p99: dv.coveredP99Abs, vs_target_max: dv.coveredMaxAbs, vs_target_rms: r2(dv.rms),
            covered_frac: r2(dv.coveredFraction),
            vs_target_mean_allpx: r2(dv.meanAbs), vs_target_max_allpx: dv.maxAbs,
            alpha_mean: r2(dv.alphaMeanAbs), alpha_max: dv.alphaMaxAbs,
            speckle_rms: r2(speckleRms(img, roi)),
            blockEdge_excess: r2(be.excess), blockEdge_across: r2(be.acrossMean), blockEdge_within: r2(be.withinMean),
            coherence_within: r3(bc.within), coherence_across: r3(bc.across), coherence_drop: r3(bc.drop),
            grain_anisotropy: r3(dc.anisotropy), grain_c0: r3(dc.c0), grain_c45: r3(dc.c45), grain_c90: r3(dc.c90), grain_c135: r3(dc.c135),
          })
          if (dpr === 2 && PNG_RADII.has(rcss) && variant !== 'converged_disc') save(`${s.name}-dpr2-r${rcss}css-${variant}`, img)
        }

        if (dpr === 2) {
          save(`zoom-${s.name}-dpr2-r${rcss}css`, montage(variants.map(([, i]) => cropZoom(i, 176, 176, 96, 96, 4))))
          if (PNG_RADII.has(rcss)) save(`compare-${s.name}-dpr2-r${rcss}css`, montage([s.img, ...variants.map(([, i]) => i)]))
        }
      }
    }
    console.log(`  degradations done: ${s.name}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
  findings.degradations = degRows

  console.log('\n=== DEGRADATIONS, DPR 2 (block = 8 device px), 8-bit codes ===')
  console.log('  zoom montage order: converged_disc | blockQuant | shader_8tap_lattice | ablate_8tap_perpixel')
  console.log(`  ${pad('stim', 15)}${padL('rCSS', 6)}  ${pad('variant', 22)}${padL('vsTgt mean', 12)}${padL('p99', 6)}${padL('max', 6)}${padL('speckle', 9)}${padL('blkExcess', 11)}${padL('cohWithin', 11)}${padL('cohAcross', 11)}${padL('cohDrop', 9)}${padL('grainAniso', 12)}${padL('alphaMax', 10)}`)
  for (const r of degRows.filter((x) => x.dpr === 2))
    console.log(`  ${pad(r.stim, 15)}${padL(r.r_css, 6)}  ${pad(r.variant, 22)}${padL(r.vs_target_mean, 12)}${padL(r.vs_target_p99, 6)}${padL(r.vs_target_max, 6)}${padL(r.speckle_rms, 9)}${padL(r.blockEdge_excess, 11)}${padL(r.coherence_within, 11)}${padL(r.coherence_across, 11)}${padL(r.coherence_drop, 9)}${padL(r.grain_anisotropy, 12)}${padL(r.alpha_max, 10)}`)

  // --- 3. tap-count convergence --------------------------------------------
  // Lattice removed, so this isolates tap count and footprint shape: how many
  // taps does a random scatter need before it matches the converged disc?
  const tapRows: Array<Record<string, unknown>> = []
  const TAP_R_CSS = 12
  for (const s of stims) {
    const src = decodeToLinear(s.img)
    const R = TAP_R_CSS * 2
    const roi = insetRoi(SIZE, SIZE, Math.min(200, Math.ceil(R * 1.5) + 8))
    const eDisc = encodeToSrgb8(discCache.get(`${s.name}|2|${TAP_R_CSS}`)!)
    const specTarget = r2(speckleRms(eDisc, roi))
    for (const taps of [8, 16, 32, 64, 128, 256]) {
      for (const fp of ['square', 'disc'] as const) {
        const img = encodeToSrgb8(sparseTapScatter(src, { halfExtentPx: R, taps, seedBlockPx: 0, footprint: fp }))
        const dv = deviation(eDisc, img, roi)
        tapRows.push({
          stim: s.name, r_css: TAP_R_CSS, taps, footprint: fp,
          vs_disc_mean: r2(dv.coveredMeanAbs), vs_disc_p99: dv.coveredP99Abs, vs_disc_rms: r2(dv.rms), vs_disc_max: dv.coveredMaxAbs,
          vs_disc_alpha_mean: r2(dv.alphaMeanAbs), vs_disc_alpha_max: dv.alphaMaxAbs,
          speckle_rms: r2(speckleRms(img, roi)), speckle_target: specTarget,
          blockEdge_excess: r2(blockEdgeExcess(img, 8, roi).excess),
        })
        if (s.name === 'photo-street' && fp === 'disc') save(`taps-photo-street-r${TAP_R_CSS}css-${String(taps).padStart(3, '0')}tap-disc`, img)
      }
    }
    console.log(`  tap sweep done: ${s.name}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
  findings.tapConvergence = tapRows

  console.log('\n=== TAP-COUNT CONVERGENCE (per-pixel seed, r=12 CSS px @ DPR2 = 24 device px) ===')
  console.log(`  ${pad('stim', 15)}${padL('taps', 6)}  ${pad('footprint', 10)}${padL('vsDisc mean', 13)}${padL('p99', 6)}${padL('max', 6)}${padL('speckle', 9)}${padL('tgtSpeckle', 12)}${padL('alphaMax', 10)}`)
  for (const r of tapRows)
    console.log(`  ${pad(r.stim, 15)}${padL(r.taps, 6)}  ${pad(r.footprint, 10)}${padL(r.vs_disc_mean, 13)}${padL(r.vs_disc_p99, 6)}${padL(r.vs_disc_max, 6)}${padL(r.speckle_rms, 9)}${padL(r.speckle_target, 12)}${padL(r.vs_disc_alpha_max, 10)}`)

  // --- 4. seed re-roll: does a converged estimator care? --------------------
  // The renderer flips DPR scale 1.0 <-> 0.75 mid-session, which re-rolls any
  // per-device-pixel seed. Simulate by re-seeding with a phase offset and
  // measuring how much the IMAGE changes. A converged estimator barely moves.
  const rerollRows: Array<Record<string, unknown>> = []
  {
    const src = decodeToLinear(stims[0].img)
    const R = 24
    const roi = insetRoi(SIZE, SIZE, Math.min(200, Math.ceil(R * 1.5) + 8))
    for (const [label, taps, block] of [
      ['shader_8tap_lattice8', 8, 8],
      ['8tap_perpixel', 8, 0],
      ['32tap_perpixel', 32, 0],
      ['128tap_perpixel', 128, 0],
    ] as Array<[string, number, number]>) {
      const a = encodeToSrgb8(sparseTapScatter(src, { halfExtentPx: R, taps, seedBlockPx: block, footprint: 'disc', seedPhase: 0 }))
      const b = encodeToSrgb8(sparseTapScatter(src, { halfExtentPx: R, taps, seedBlockPx: block, footprint: 'disc', seedPhase: 977 }))
      const dv = deviation(a, b, roi)
      rerollRows.push({ variant: label, taps, seed_block_devpx: block, reroll_mean: r2(dv.coveredMeanAbs), reroll_p99: dv.coveredP99Abs, reroll_max: dv.coveredMaxAbs })
    }
  }
  findings.seedReroll = rerollRows
  console.log('\n=== SEED RE-ROLL (image change when the seed grid shifts; photo-street, r=12 CSS @ DPR2) ===')
  console.log(`  ${pad('variant', 24)}${padL('mean', 8)}${padL('p99', 6)}${padL('max', 6)}`)
  for (const r of rerollRows) console.log(`  ${pad(r.variant, 24)}${padL(r.reroll_mean, 8)}${padL(r.reroll_p99, 6)}${padL(r.reroll_max, 6)}`)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const jsonPath = path.join(OUT_DIR, 'phase9-target.json')
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    geometry: {
      halfExtentDevicePx: 'frost * 24 * u_dpr',
      frostForRcss: { 6: 0.25, 12: 0.5, 18: 0.75, 24: 1.0 },
      latticeCellDevicePx: 'u_dpr * 4  (4 @ DPR1, 8 @ DPR2)',
      imagePixel: 'one device pixel; DPR2 grid is the headline',
      stimulusSize: SIZE,
      roi: 'inset by min(200, ceil(1.5*R)+8) px so clamp/mirror edge policy never enters a number',
    },
    stimuli: stims.map((s) => ({ name: s.name, note: s.note })),
    ...findings,
  }, null, 2))
  console.log(`\nwrote ${jsonPath}`)
  console.log(`wrote ${files.length} PNGs under ${IMG_DIR}`)
  console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (failed.length) console.log(`\nCALIBRATION FAILURES: ${failed.map((g) => g.id).join(', ')}`)
}

main()
