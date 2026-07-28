/**
 * Phase 14 helper — re-crop the 6x plates at higher magnification so the
 * pixel-level contour shape can be read back as an image, not inferred from
 * statistics. Pure image manipulation on files phase14-gt-convergence.ts wrote;
 * no GPU, no shader.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase14-zoom.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { decodePng, encodePng } from './lib/png.ts'
import type { Rgba8 } from './lib/image.ts'

const DIR = path.join(process.cwd(), 'reports', 'blur-bakeoff', 'phase14')

function crop(img: Rgba8, x0: number, y0: number, w: number, h: number): Rgba8 {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.width + (x0 + x)) * 4
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = img.data[s + c]
    }
  }
  return { width: w, height: h, data: out }
}

function zoom(img: Rgba8, k: number): Rgba8 {
  const w = img.width * k
  const h = img.height * k
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = img.data[s + c]
    }
  }
  return { width: w, height: h, data: out }
}

function hstack(a: Rgba8, b: Rgba8, gap: number): Rgba8 {
  const w = a.width + b.width + gap
  const h = Math.max(a.height, b.height)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < out.length; i += 4) { out[i] = 255; out[i + 1] = 0; out[i + 2] = 128; out[i + 3] = 255 }
  const blit = (im: Rgba8, ox: number): void => {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const s = (y * im.width + x) * 4
        const o = (y * w + ox + x) * 4
        for (let c = 0; c < 4; c++) out[o + c] = im.data[s + c]
      }
    }
  }
  blit(a, 0)
  blit(b, a.width + gap)
  return { width: w, height: h, data: out }
}

/** Column i of a 5-column plate built with 240 px columns and 8 px dividers. */
function column(plate: Rgba8, i: number, colW = 240, gap = 8): Rgba8 {
  return crop(plate, i * (colW + gap), 0, colW, plate.height)
}

for (const stim of ['flat', 'hicon']) {
  const plate = decodePng(new Uint8Array(fs.readFileSync(path.join(DIR, `plate-${stim}-seam-6x-norm.png`))))
  const shipped = column(plate, 0)
  const gt = column(plate, 4)
  // 20 x 24 source px (already at 6x = 120 x 144 plate px) -> 4x more = 24x total
  const cw = 120
  const ch = 144
  const x0 = Math.max(0, Math.floor((shipped.width - cw) / 2))
  const y0 = Math.max(0, Math.floor((shipped.height - ch) / 2))
  const pair = hstack(zoom(crop(shipped, x0, y0, cw, ch), 4), zoom(crop(gt, x0, y0, cw, ch), 4), 10)
  const name = `zoom24x-${stim}-SHIPPED1-vs-GT64.png`
  fs.writeFileSync(path.join(DIR, name), encodePng(pair))
  console.log(`${name}  ${pair.width}x${pair.height}  (left SHIPPED 1-tap, right GT 64x64, 24x nearest, same contrast stretch)`)
}
