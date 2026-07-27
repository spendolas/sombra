/**
 * Phase 8 — quantify the edge artefact the user reported: blurred edges "jump"
 * when the canvas resizes.
 *
 * Mechanism under test. Sombra pins procedural content to the Fragment Output
 * anchor (auto_uv is anchor-relative, u_ref_size is a constant 512), so resizing
 * reveals/hides content at the borders rather than zooming — deliberate, per
 * CLAUDE.md. A pass boundary then SNAPSHOTS only the canvas rectangle. Within ~4
 * sigma of a border the blur needs content that no longer exists, and
 * clamp-to-edge smears the border texel instead. Because a different partial cell
 * sits at the border at each canvas width, that smear differs per width — which is
 * what reads as a jump.
 *
 * This measures three things:
 *   1. how wrong the border band is versus true infinite-extent content
 *   2. how much that band CHANGES between two canvas widths (the jump itself)
 *   3. whether an over-render margin removes it — the candidate fix, which needs
 *      per-pass resolution the engine does not have yet
 *
 * Run: npx tsx scripts/blur-bakeoff/phase8-edges.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Rig, type Backend } from './lib/gpu-rig'
import { ingestPass, egressPass, gaussKernelPass } from './lib/shaders'
import { type Rgba8 } from './lib/image'
import { encodePng } from './lib/png'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase8')
const B: Backend = 'webgpu'

/** Reference-size model constants, mirroring src/renderer/constants.ts. */
const REF_SIZE = 512
const DPR = 1
const ANCHOR = 0.5

const SIGMA = 12
const CELL_REF = 40 // checkerboard cell size in reference px
const HEIGHT = 256

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMG_DIR, `${name}.png`), encodePng(img))
}

/**
 * Anchor-relative checkerboard, generated the way Sombra's auto_uv does:
 *   uv = (fragXY - resolution*anchor) / (dpr*ref_size) + anchor
 * so the pattern is pinned to the canvas centre and resizing reveals/hides edges.
 * `originX` lets us render the SAME infinite pattern over a shifted window, which
 * is how the over-render margin is simulated.
 */
function anchoredChecker(width: number, height: number, originX = 0, anchorWidth = width): Rgba8 {
  const img: Rgba8 = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  const unit = DPR * REF_SIZE
  const cell = CELL_REF / unit
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // position in the window, then in the canvas the window belongs to.
      // anchorWidth is the width of the CANVAS this pattern is anchored to, which
      // differs from the render width when an over-render margin is simulated —
      // using the render width there re-centres the pattern and misaligns the crop.
      const canvasX = x + originX
      const u = (canvasX - anchorWidth * ANCHOR) / unit + ANCHOR
      const v = (y - height * ANCHOR) / unit + ANCHOR
      const cx = Math.floor(u / cell)
      const cy = Math.floor(v / cell)
      const on = ((cx + cy) % 2 + 2) % 2 === 0
      const val = on ? 255 : 0
      const i = (y * width + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = val
      img.data[i + 3] = 255
    }
  }
  return img
}

/** Crop a horizontal window out of an image. */
function cropX(img: Rgba8, x0: number, w: number): Rgba8 {
  const out: Rgba8 = { width: w, height: img.height, data: new Uint8ClampedArray(w * img.height * 4) }
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++)
        out.data[(y * w + x) * 4 + c] = img.data[(y * img.width + (x0 + x)) * 4 + c]
  return out
}

function bandStats(a: Rgba8, b: Rgba8, x0: number, x1: number): { mean: number; max: number } {
  let s = 0, n = 0, m = 0
  for (let y = 0; y < Math.min(a.height, b.height); y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[(y * a.width + x) * 4 + c] - b.data[(y * b.width + x) * 4 + c])
        s += d; n++; if (d > m) m = d
      }
  return { mean: n ? s / n : 0, max: m }
}

const blurPasses = () => [
  ingestPass(B),
  gaussKernelPass(B, SIGMA, 'h'),
  gaussKernelPass(B, SIGMA, 'v'),
  egressPass(B, { dither: false }),
]

async function blurred(rig: Rig, src: Rgba8): Promise<Rgba8> {
  return await rig.capture({ backend: B, width: src.width, height: src.height, input: src, passes: blurPasses() })
}

async function main() {
  const rig = await createRig()
  const findings: Array<Record<string, unknown>> = []
  try {
    // Kernel support: taps reach 4 sigma, so this is the suspect band width.
    const support = Math.ceil(SIGMA * 4)

    // --- 1. how wrong is the border band, vs true infinite content? ---------
    // Truth: render a canvas WIDER by `support` on each side, blur it, then crop
    // back. The interior of that wider render had real neighbours available.
    const W = 512
    const narrow = anchoredChecker(W, HEIGHT)
    const wide = anchoredChecker(W + support * 2, HEIGHT, -support, W)
    const narrowBlur = await blurred(rig, narrow)
    const wideBlurCropped = cropX(await blurred(rig, wide), support, W)

    const edge = bandStats(narrowBlur, wideBlurCropped, 0, support)
    const interior = bandStats(narrowBlur, wideBlurCropped, support * 2, W - support * 2)
    save('edge-clamped', narrowBlur)
    save('edge-overrendered', wideBlurCropped)
    findings.push({
      id: 'border-band-error',
      sigma: SIGMA,
      band_width_px: support,
      border_mean_err: +edge.mean.toFixed(2),
      border_max_err: edge.max,
      interior_mean_err: +interior.mean.toFixed(2),
      interior_max_err: interior.max,
      note: 'clamp-to-edge vs the same content rendered with a margin; interior should be ~0',
    })
    console.log(`border band (${support}px): mean ${edge.mean.toFixed(2)} max ${edge.max}  |  interior: mean ${interior.mean.toFixed(2)} max ${interior.max}`)

    // --- 2. the jump: does the border band change between canvas widths? -----
    // Two widths, anchor-relative content. Align both to the anchor (canvas
    // centre) and compare a fixed-size window at the LEFT border.
    const rows: Array<Record<string, unknown>> = []
    for (const [w1, w2] of [[550, 502], [512, 480], [512, 511]] as Array<[number, number]>) {
      const b1 = await blurred(rig, anchoredChecker(w1, HEIGHT))
      const b2 = await blurred(rig, anchoredChecker(w2, HEIGHT))
      // both are anchored at their own centre; compare the first `support` columns
      const win = Math.min(support, Math.min(w1, w2))
      const e1 = cropX(b1, 0, win)
      const e2 = cropX(b2, 0, win)
      const jump = bandStats(e1, e2, 0, win)
      // control: the same comparison well inside the frame, aligned to centre
      const mid1 = cropX(b1, Math.floor(w1 / 2) - 64, 128)
      const mid2 = cropX(b2, Math.floor(w2 / 2) - 64, 128)
      const midJump = bandStats(mid1, mid2, 0, 128)
      rows.push({
        widths: `${w1} -> ${w2}`,
        border_change_mean: +jump.mean.toFixed(2), border_change_max: jump.max,
        centre_change_mean: +midJump.mean.toFixed(2), centre_change_max: midJump.max,
      })
      console.log(`resize ${w1}->${w2}: border changes ${jump.mean.toFixed(2)}/${jump.max}, centre changes ${midJump.mean.toFixed(2)}/${midJump.max}`)
    }
    findings.push({ id: 'resize-jump', detail: rows, note: 'border vs centre change across a resize; centre is the control' })

    // --- 3. does an over-render margin fix it? -------------------------------
    // Repeat the resize test, but give each render a margin of `support` and crop.
    const fixedRows: Array<Record<string, unknown>> = []
    for (const [w1, w2] of [[550, 502]] as Array<[number, number]>) {
      const f1 = cropX(await blurred(rig, anchoredChecker(w1 + support * 2, HEIGHT, -support, w1)), support, w1)
      const f2 = cropX(await blurred(rig, anchoredChecker(w2 + support * 2, HEIGHT, -support, w2)), support, w2)
      const win = Math.min(support, Math.min(w1, w2))
      const jump = bandStats(cropX(f1, 0, win), cropX(f2, 0, win), 0, win)
      fixedRows.push({ widths: `${w1} -> ${w2}`, border_change_mean: +jump.mean.toFixed(2), border_change_max: jump.max })
      console.log(`WITH margin, resize ${w1}->${w2}: border changes ${jump.mean.toFixed(2)}/${jump.max}`)
      save('jump-margin-550', f1)
      save('jump-margin-502', f2)
    }
    findings.push({ id: 'over-render-fix', detail: fixedRows, note: 'same resize with a 4-sigma margin rendered and cropped' })
  } finally {
    await rig.close()
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase8.json'), JSON.stringify({ sigma: SIGMA, findings }, null, 2))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase8.json')}`)
}

main()
