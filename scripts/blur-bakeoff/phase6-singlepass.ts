/**
 * Phase 6 — how good can a SINGLE-PASS blur be?
 *
 * Sombra's compiler gives each node exactly one pass (partitionPasses assigns one
 * depth per node), so a real blur node cannot do a separable H-then-V blur, and
 * the recommended pyramid additionally needs per-pass resolution that RenderPass
 * does not have. Before proposing framework changes it is worth knowing what the
 * best node buildable today actually looks like.
 *
 * Candidate: a fixed-tap sunflower Gaussian gather, judged against the same
 * matched-ideal gate as the Phase 3 bake-off.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase6-singlepass.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Backend, type PassSpec } from './lib/gpu-rig'
import { ingestPass, egressPass, sunflowerGaussPass, linearSampledGaussPass } from './lib/shaders'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './lib/image'
import { gaussianBlur } from './lib/reference'
import { ringingScore } from './lib/detectors'
import { encodePng } from './lib/png'
import { stepEdge, hfNoise, transparentEdgeSprite } from './lib/corpus'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase6')
const B: Backend = 'webgpu'

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMG_DIR, `${name}.png`), encodePng(img))
}
function meanAbs(a: Rgba8, b: Rgba8): number {
  let s = 0, n = 0
  for (let p = 0; p < a.width * a.height; p++) for (let c = 0; c < 3; c++) { s += Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); n++ }
  return s / n
}
function maxAbs(a: Rgba8, b: Rgba8): number {
  let m = 0
  for (let p = 0; p < a.width * a.height; p++) for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]); if (d > m) m = d }
  return m
}

interface Row {
  taps: number | string
  sigma: number
  edge_mean: number
  edge_max: number
  noise_mean: number
  noise_max: number
  ringing: number
  flaws: string[]
}
const rows: Row[] = []

async function main() {
  const rig = await createRig()
  try {
    for (const sigma of [4, 12, 32]) {
      const SIZE = Math.min(1024, Math.max(256, Math.ceil((sigma * 12) / 64) * 64))
      const edge = stepEdge(SIZE, SIZE)
      const noise = hfNoise(SIZE, SIZE, 5)
      const edgeRef = encodeToSrgb8(gaussianBlur(decodeToLinear(edge), sigma, { premultiplied: true }))
      const noiseRef = encodeToSrgb8(gaussianBlur(decodeToLinear(noise), sigma, { premultiplied: true }))

      const variants: Array<{ label: number | string; kernels: PassSpec[] }> = [
        ...[24, 48, 96, 192].map((t) => ({ label: t, kernels: [sunflowerGaussPass(B, sigma, t)] })),
        // two-pass separable, for reference: what a second pass would buy
        { label: 'separable (2 passes)', kernels: [linearSampledGaussPass(B, sigma, 'h'), linearSampledGaussPass(B, sigma, 'v')] },
      ]

      for (const v of variants) {
        const passes = [ingestPass(B), ...v.kernels, egressPass(B, { dither: true })]
        const e = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: edge, passes })
        const n = await rig.capture({ backend: B, width: SIZE, height: SIZE, input: noise, passes })
        const row: Row = {
          taps: v.label, sigma,
          edge_mean: +meanAbs(e, edgeRef).toFixed(2), edge_max: maxAbs(e, edgeRef),
          noise_mean: +meanAbs(n, noiseRef).toFixed(2), noise_max: maxAbs(n, noiseRef),
          ringing: +ringingScore(decodeToLinear(e), decodeToLinear(edge)).toFixed(4),
          flaws: [],
        }
        // same gate as Phase 3
        if (row.edge_mean > 2) row.flaws.push(`edge shape ${row.edge_mean}`)
        if (row.edge_max > 16) row.flaws.push(`edge worst ${row.edge_max}`)
        if (row.noise_mean > 2) row.flaws.push(`detail ${row.noise_mean}`)
        if (row.ringing > 0.02) row.flaws.push(`ringing ${row.ringing}`)
        rows.push(row)
        console.log(`  sigma ${String(sigma).padEnd(3)} taps ${String(v.label).padEnd(22)} edge ${row.edge_mean}/${row.edge_max}  detail ${row.noise_mean}/${row.noise_max}  ${row.flaws.length ? 'FLAWED: ' + row.flaws.join('; ') : 'clean'}`)
        if (sigma === 32) save(`s32-${String(v.label).replace(/\W+/g, '-')}-noise`, n)
      }
      if (sigma === 32) save('s32-reference-noise', noiseRef)
    }

    // alpha behaviour of the best single-pass variant
    const sprite = transparentEdgeSprite(256, 256)
    const spriteOut = await rig.capture({
      backend: B, width: 256, height: 256, input: sprite,
      passes: [ingestPass(B), sunflowerGaussPass(B, 12, 96), egressPass(B, { dither: true })],
    })
    save('sprite-sunflower-96', spriteOut)
  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase6.json'), JSON.stringify({ rows }, null, 2))
  const md = [
    '# Phase 6 — best achievable single-pass blur',
    '',
    'Sombra gives a node exactly one pass, so a node cannot do a separable blur.',
    'This measures the best single-pass alternative (fixed-tap sunflower Gaussian',
    'gather) against the same matched-ideal gate used in Phase 3.',
    '',
    '| sigma | taps | edge err mean/max | detail err mean/max | ringing | verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.sigma} | ${r.taps} | ${r.edge_mean} / ${r.edge_max} | ${r.noise_mean} / ${r.noise_max} | ${r.ringing} | ${r.flaws.length ? '**FLAWED**: ' + r.flaws.join('; ') : 'clean'} |`),
    '',
  ]
  fs.writeFileSync(path.join(OUT_DIR, 'phase6.md'), md.join('\n'))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase6.md')}`)
}

main()
