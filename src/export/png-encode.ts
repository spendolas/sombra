/**
 * Deterministic PNG encoder (fflate zlib + hand-rolled CRC32).
 *
 * WHY THIS EXISTS: the PNG-sequence export used to encode each frame with the
 * browser's `OffscreenCanvas.convertToBlob('image/png')`. That path is
 * non-deterministic across engines — Chrome's built-in PNG deflate is far
 * weaker than Safari's, so the SAME pixels produce ~2× larger files in Chrome
 * (measured 3.27 MB/frame vs 1.56 MB). This encoder replaces it with pure-JS
 * codegen so the output bytes depend only on the input pixels and the deflate
 * `level` — never on the host engine. `fflate.zlibSync` is deterministic pure
 * JS, so `encodePng` is byte-identical for identical input on every browser.
 *
 * Format: 8-byte signature + IHDR (8-bit, colour type 6 = truecolour+alpha,
 * compression 0 / filter 0 / interlace 0) + IDAT (adaptively filtered scanlines
 * compressed with zlib) + IEND. Straight (non-premultiplied) alpha is preserved
 * verbatim, so a transparent-background export round-trips losslessly.
 */

import { zlibSync } from 'fflate'

// --- CRC32 (ISO 3309 / PNG spec) --------------------------------------------
// Standard reflected CRC32 with polynomial 0xEDB88320. Table built once. fflate
// does not export a public CRC helper usable here, and the whole point is to add
// NO new dependency, so we carry our own tiny implementation.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// --- Paeth predictor (PNG spec 9.4) -----------------------------------------
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

const BPP = 4 // bytes per pixel for colour type 6 @ 8-bit depth (RGBA)

/**
 * Build the filtered scanline stream: each row is prefixed with a filter-type
 * byte, then the row's bytes filtered by that method. We use ADAPTIVE per-line
 * filtering — for each row we compute all five filters (None/Sub/Up/Average/
 * Paeth) and pick the one with the minimum sum of absolute signed-byte
 * residuals (the standard "minimum sum of absolute differences" heuristic).
 * The choice is a pure function of the pixels, so it is fully deterministic and
 * typically compresses better than any single fixed filter.
 */
function filterScanlines(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const stride = width * BPP
  // Output: one filter byte + one filtered row per scanline.
  const out = new Uint8Array(height * (stride + 1))
  // Reusable per-filter candidate buffers (one filtered row each).
  const cand: Uint8Array[] = [
    new Uint8Array(stride), // 0 None
    new Uint8Array(stride), // 1 Sub
    new Uint8Array(stride), // 2 Up
    new Uint8Array(stride), // 3 Average
    new Uint8Array(stride), // 4 Paeth
  ]

  let outPos = 0
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride
    const prevStart = rowStart - stride // valid only when y > 0

    for (let i = 0; i < stride; i++) {
      const raw = rgba[rowStart + i]
      const a = i >= BPP ? rgba[rowStart + i - BPP] : 0 // left
      const b = y > 0 ? rgba[prevStart + i] : 0 // up
      const c = y > 0 && i >= BPP ? rgba[prevStart + i - BPP] : 0 // up-left

      cand[0][i] = raw
      cand[1][i] = (raw - a) & 0xff
      cand[2][i] = (raw - b) & 0xff
      cand[3][i] = (raw - ((a + b) >> 1)) & 0xff
      cand[4][i] = (raw - paeth(a, b, c)) & 0xff
    }

    // Score each candidate by sum of absolute residuals interpreted as SIGNED
    // bytes (values 128..255 map to -128..-1), per the PNG filtering heuristic.
    let best = 0
    let bestScore = Infinity
    for (let f = 0; f < 5; f++) {
      const buf = cand[f]
      let score = 0
      for (let i = 0; i < stride; i++) {
        const v = buf[i]
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        best = f
      }
    }

    out[outPos++] = best
    out.set(cand[best], outPos)
    outPos += stride
  }
  return out
}

// --- Chunk assembly ---------------------------------------------------------
function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)])
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const crc = crc32(body)

  const result = new Uint8Array(4 + body.length + 4)
  result.set(u32(data.length), 0) // length = data only (excludes type + crc)
  result.set(body, 4) // type + data
  result.set(u32(crc), 4 + body.length) // crc over type + data
  return result
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

/**
 * Encode straight-alpha RGBA pixels into a complete PNG file.
 *
 * @param rgba   Row-major, top-down RGBA bytes, length `width * height * 4`.
 *               Straight (non-premultiplied) alpha — preserved exactly.
 * @param width  Image width in pixels (>= 1).
 * @param height Image height in pixels (>= 1).
 * @param opts.level zlib/deflate compression level 0..9 (default 6, balanced).
 * @returns A complete PNG file as a Uint8Array.
 */
export function encodePng(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { level?: number },
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`[png-encode] invalid dimensions ${width}x${height}`)
  }
  const expected = width * height * BPP
  if (rgba.length !== expected) {
    throw new Error(`[png-encode] rgba length ${rgba.length} != width*height*4 (${expected})`)
  }
  const level = (opts?.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

  // IHDR: width, height, bit depth 8, colour type 6 (RGBA), compression 0,
  // filter 0, interlace 0.
  const ihdr = new Uint8Array(13)
  ihdr.set(u32(width), 0)
  ihdr.set(u32(height), 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method

  const filtered = filterScanlines(rgba, width, height)
  // zlibSync produces a zlib-WRAPPED deflate stream — exactly what PNG IDAT
  // requires. (Raw deflateSync would omit the zlib header/adler and be invalid.)
  const idat = zlibSync(filtered, { level })

  const ihdrChunk = chunk('IHDR', ihdr)
  const idatChunk = chunk('IDAT', idat)
  const iendChunk = chunk('IEND', new Uint8Array(0))

  const total = PNG_SIGNATURE.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  const png = new Uint8Array(total)
  let pos = 0
  png.set(PNG_SIGNATURE, pos)
  pos += PNG_SIGNATURE.length
  png.set(ihdrChunk, pos)
  pos += ihdrChunk.length
  png.set(idatChunk, pos)
  pos += idatChunk.length
  png.set(iendChunk, pos)
  return png
}
