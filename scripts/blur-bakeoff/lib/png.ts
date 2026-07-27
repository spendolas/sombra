// Minimal, dependency-light PNG codec (8-bit, non-interlaced) for the harness.
// Uses pako (already a repo dependency) for the zlib stage. No native deps, so it
// is safe under the repo's arch-specific-node_modules constraint.
//
// encodePng: always writes 8-bit RGBA (color type 6), one chosen filter per scanline.
// decodePng: reads 8-bit color type 6 (RGBA) and 2 (RGB, alpha forced to 255),
//            non-interlaced, applying all five PNG filter types. This covers every
//            PNG we generate and every PNG a Chromium canvas readback produces.

import { deflate, inflate } from 'pako'
import type { Rgba8 } from './image'

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

// ---- CRC32 (PNG polynomial) ------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---- byte helpers ----------------------------------------------------------
function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)])
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(4 + body.length + 4)
  out.set(u32(data.length), 0)
  out.set(body, 4)
  out.set(u32(crc32(body)), 4 + body.length)
  return out
}

// ---- encode ----------------------------------------------------------------
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function encodePng(img: Rgba8, opts?: { filter?: 0 | 1 | 2 | 3 | 4 }): Uint8Array {
  const { width, height, data } = img
  const filter = opts?.filter ?? 0
  const bpp = 4 // RGBA bytes per pixel
  const stride = width * bpp

  // Build filtered raw stream: one filter-type byte + filtered scanline per row.
  const raw = new Uint8Array(height * (1 + stride))
  const prevLine = new Uint8Array(stride)
  const curLine = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < stride; x++) curLine[x] = data[y * stride + x]
    const rowStart = y * (1 + stride)
    raw[rowStart] = filter
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? curLine[x - bpp] : 0
      const b = prevLine[x]
      const c = x >= bpp ? prevLine[x - bpp] : 0
      let v: number
      switch (filter) {
        case 1: v = curLine[x] - a; break
        case 2: v = curLine[x] - b; break
        case 3: v = curLine[x] - ((a + b) >> 1); break
        case 4: v = curLine[x] - paethPredictor(a, b, c); break
        default: v = curLine[x]
      }
      raw[rowStart + 1 + x] = v & 0xff
    }
    prevLine.set(curLine)
  }

  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]) // 8-bit, RGBA, deflate, no filter method, no interlace
  const idat = deflate(raw)

  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ---- decode ----------------------------------------------------------------
export function decodePng(png: Uint8Array): Rgba8 {
  for (let i = 0; i < 8; i++) if (png[i] !== SIGNATURE[i]) throw new Error('not a PNG')

  let pos = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = -1
  const idatParts: Uint8Array[] = []
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  while (pos < png.length) {
    const len = view.getUint32(pos)
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7])
    const dataStart = pos + 8
    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = png[dataStart + 8]
      colorType = png[dataStart + 9]
      const interlace = png[dataStart + 12]
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
      if (colorType !== 6 && colorType !== 2) throw new Error(`unsupported color type ${colorType}`)
      if (interlace !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') {
      idatParts.push(png.subarray(dataStart, dataStart + len))
    } else if (type === 'IEND') {
      break
    }
    pos = dataStart + len + 4 // skip data + CRC
  }

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const compressed = concat(idatParts)
  const raw = inflate(compressed)

  // Unfilter scanlines in place.
  const recon = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (1 + stride)]
    const src = y * (1 + stride) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[dst + x - channels] : 0
      const b = y > 0 ? recon[dst - stride + x] : 0
      const c = x >= channels && y > 0 ? recon[dst - stride + x - channels] : 0
      const val = raw[src + x]
      let recon_x: number
      switch (filterType) {
        case 1: recon_x = val + a; break
        case 2: recon_x = val + b; break
        case 3: recon_x = val + ((a + b) >> 1); break
        case 4: recon_x = val + paethPredictor(a, b, c); break
        default: recon_x = val
      }
      recon[dst + x] = recon_x & 0xff
    }
  }

  // Expand to RGBA.
  const out = new Uint8ClampedArray(width * height * 4)
  if (channels === 4) {
    out.set(recon)
  } else {
    for (let p = 0; p < width * height; p++) {
      out[p * 4] = recon[p * 3]
      out[p * 4 + 1] = recon[p * 3 + 1]
      out[p * 4 + 2] = recon[p * 3 + 2]
      out[p * 4 + 3] = 255
    }
  }
  return { width, height, data: out }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
