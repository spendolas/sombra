/**
 * Phase 3b — validate the bake-off winner on real content and on both backends.
 *
 * The synthetic provocations decide flawlessness, but the recommendation has to
 * hold on photographs and on the WebGL2 fallback too, otherwise it is only a
 * WebGPU result. Produces the visual proof pack.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase3b-winner.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Backend, type PassSpec } from './lib/gpu-rig'
import {
  ingestPass, egressPass, linearSampledGaussPass,
  dualFilterDownPass, dualFilterUpPass, kawasePass,
} from './lib/shaders'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './lib/image'
import { gaussianBlur } from './lib/reference'
import { encodePng } from './lib/png'
import { transparentEdgeSprite } from './lib/corpus'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase3b')
const PHOTO_DIR = 'stuff'
const MAX_PHOTO = 512

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMG_DIR, `${name}.png`), encodePng(img))
}
function meanAbs(a: Rgba8, b: Rgba8): number {
  let s = 0, n = 0
  for (let p = 0; p < Math.min(a.width * a.height, b.width * b.height); p++)
    for (let c = 0; c < 3; c++) { s += Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); n++ }
  return s / n
}
function maxAbs(a: Rgba8, b: Rgba8): number {
  let m = 0
  for (let p = 0; p < Math.min(a.width * a.height, b.width * b.height); p++)
    for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); if (d > m) m = d }
  return m
}

/** The winner: radius-adaptive pyramid with a linear-sampled Gaussian at the core. */
function pyramidGauss(backend: Backend, sigma: number): PassSpec[] {
  const TARGET_SMALL = 4
  const levels = Math.max(0, Math.min(5, Math.floor(Math.log2(sigma / TARGET_SMALL))))
  const smallSigma = sigma / 2 ** levels
  const s = 1 / 2 ** levels
  const passes: PassSpec[] = []
  for (let i = 1; i <= levels; i++) passes.push({ ...dualFilterDownPass(backend), scale: 1 / 2 ** i })
  passes.push({ ...linearSampledGaussPass(backend, smallSigma, 'h'), scale: s })
  passes.push({ ...linearSampledGaussPass(backend, smallSigma, 'v'), scale: s })
  for (let i = levels - 1; i >= 0; i--) passes.push({ ...dualFilterUpPass(backend), scale: 1 / 2 ** i })
  return [ingestPass(backend), ...passes, egressPass(backend, { dither: true })]
}

/** The no-engine-change fallback: linear-sampled separable Gaussian at full res. */
function linSampled(backend: Backend, sigma: number): PassSpec[] {
  return [
    ingestPass(backend),
    linearSampledGaussPass(backend, sigma, 'h'),
    linearSampledGaussPass(backend, sigma, 'v'),
    egressPass(backend, { dither: true }),
  ]
}

/** For contrast in the proof pack: the cheap option that showed a visible grid. */
function kawase5(backend: Backend, scale: number): PassSpec[] {
  const seq = [0, 1, 2, 2, 3]
  return [
    ingestPass(backend),
    ...seq.map((o) => kawasePass(backend, (o + 0.5) * scale - 0.5)),
    egressPass(backend, { dither: true }),
  ]
}

interface PhotoRow { photo: string; sigma: number; crossBackendMean: number; crossBackendMax: number; vsRefMean: number; vsRefMax: number }
const photoRows: PhotoRow[] = []
const notes: string[] = []

async function main() {
  const rig = await createRig()
  try {
    // ---- real photographs -------------------------------------------------
    const files = fs.existsSync(PHOTO_DIR)
      ? fs.readdirSync(PHOTO_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f))
      : []
    if (!files.length) notes.push(`no photos found in ${PHOTO_DIR}/ — real-content check skipped`)

    for (const file of files) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(PHOTO_DIR, file)))
      const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg'
      const img = await rig.decodeImage(bytes, mime, MAX_PHOTO)
      const slug = file.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase().slice(0, 40)
      save(`photo-${slug}-00-source`, img)
      console.log(`  ${file} -> ${img.width}x${img.height}`)

      for (const sigma of [8, 32]) {
        const a = await rig.capture({ backend: 'webgpu', width: img.width, height: img.height, input: img, passes: pyramidGauss('webgpu', sigma) })
        const b = await rig.capture({ backend: 'webgl2', width: img.width, height: img.height, input: img, passes: pyramidGauss('webgl2', sigma) })
        const ref = encodeToSrgb8(gaussianBlur(decodeToLinear(img), sigma, { premultiplied: true }))
        save(`photo-${slug}-s${sigma}-pyramid-webgpu`, a)
        save(`photo-${slug}-s${sigma}-reference`, ref)
        photoRows.push({
          photo: file, sigma,
          crossBackendMean: +meanAbs(a, b).toFixed(2), crossBackendMax: maxAbs(a, b),
          vsRefMean: +meanAbs(a, ref).toFixed(2), vsRefMax: maxAbs(a, ref),
        })
        console.log(`    sigma ${sigma}: cross-backend ${meanAbs(a, b).toFixed(2)} mean, vs reference ${meanAbs(a, ref).toFixed(2)} mean`)
      }
    }

    // ---- side-by-side plate at a wide radius, incl. the flawed contender ---
    const plateSrc = files.length
      ? await rig.decodeImage(new Uint8Array(fs.readFileSync(path.join(PHOTO_DIR, files[0]))), /\.png$/i.test(files[0]) ? 'image/png' : 'image/jpeg', MAX_PHOTO)
      : transparentEdgeSprite(384, 384)
    const SIG = 32
    save('plate-0-source', plateSrc)
    save('plate-1-reference', encodeToSrgb8(gaussianBlur(decodeToLinear(plateSrc), SIG, { premultiplied: true })))
    save('plate-2-pyramid-gauss', await rig.capture({ backend: 'webgpu', width: plateSrc.width, height: plateSrc.height, input: plateSrc, passes: pyramidGauss('webgpu', SIG) }))
    save('plate-3-linear-sampled', await rig.capture({ backend: 'webgpu', width: plateSrc.width, height: plateSrc.height, input: plateSrc, passes: linSampled('webgpu', SIG) }))
    save('plate-4-kawase-flawed', await rig.capture({ backend: 'webgpu', width: plateSrc.width, height: plateSrc.height, input: plateSrc, passes: kawase5('webgpu', 11) }))

    // ---- transparency behaviour of the winner -----------------------------
    const sprite = transparentEdgeSprite(256, 256)
    const spriteOut = await rig.capture({ backend: 'webgpu', width: 256, height: 256, input: sprite, passes: pyramidGauss('webgpu', 12) })
    save('sprite-source', sprite)
    save('sprite-pyramid-gauss', spriteOut)

    // ---- alpha passthrough check (repo rule: never invent alpha) ----------
    // A fully opaque image must come back fully opaque.
    const opaque: Rgba8 = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }
    for (let p = 0; p < 64 * 64; p++) {
      opaque.data[p * 4] = 200; opaque.data[p * 4 + 1] = 120; opaque.data[p * 4 + 2] = 60; opaque.data[p * 4 + 3] = 255
    }
    const opaqueOut = await rig.capture({ backend: 'webgpu', width: 64, height: 64, input: opaque, passes: pyramidGauss('webgpu', 8) })
    let minAlpha = 255
    for (let p = 0; p < 64 * 64; p++) minAlpha = Math.min(minAlpha, opaqueOut.data[p * 4 + 3])
    notes.push(`opaque input stays opaque through the winner: min alpha ${minAlpha}/255 (expect 255)`)
    console.log(`  alpha passthrough: min alpha ${minAlpha}/255`)

    // ---- WebGL2 pass-count reality check ----------------------------------
    const p64 = pyramidGauss('webgpu', 64)
    notes.push(
      `the winner uses ${p64.length} passes at sigma 64 (incl. ingest/egress); the WebGL2 backend caps ` +
      `intermediates at min(8, maxTextureUnits-1), so a deep pyramid needs that cap raised or ping-pong reuse`,
    )
  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const md: string[] = [
    '# Phase 3b — winner validation on real content and both backends',
    '',
    'The winner is the radius-adaptive pyramid Gaussian: progressive halving, a',
    'linear-sampled Gaussian at the coarse level, progressive upsampling, wrapped in',
    'the linear-light / premultiplied-alpha bracket with output dither.',
    '',
    '## Photographs',
    '',
    '| photo | sigma | cross-backend mean/max | vs ideal Gaussian mean/max |',
    '| --- | --- | --- | --- |',
    ...photoRows.map((r) => `| ${r.photo} | ${r.sigma} | ${r.crossBackendMean} / ${r.crossBackendMax} | ${r.vsRefMean} / ${r.vsRefMax} |`),
    '',
    '## Notes',
    '',
    ...notes.map((n) => `- ${n}`),
    '',
    '## Proof images (`phase3b/`)',
    '',
    '- `plate-0-source` → `plate-1-reference` → `plate-2-pyramid-gauss` → `plate-3-linear-sampled` → `plate-4-kawase-flawed`',
    '- `photo-*-s{8,32}-pyramid-webgpu` against `photo-*-s{8,32}-reference`',
    '- `sprite-*` shows transparent-edge behaviour',
    '',
  ]
  fs.writeFileSync(path.join(OUT_DIR, 'phase3b.md'), md.join('\n'))
  fs.writeFileSync(path.join(OUT_DIR, 'phase3b.json'), JSON.stringify({ photoRows, notes }, null, 2))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase3b.md')}`)
}

main()
