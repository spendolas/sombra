/**
 * verify:png-encode — gate for the deterministic PNG encoder (src/export/png-encode.ts).
 *
 * The encoder replaces the browser's non-deterministic `convertToBlob('image/png')`
 * in the PNG-sequence export. Because it is pure JS (fflate zlib + hand-rolled
 * CRC32), it MUST be lossless, structurally valid, and byte-identical for
 * identical input on every engine. This gate runs entirely in Node via tsx — no
 * browser needed — and asserts:
 *
 *   #1 round-trip lossless: encode a buffer containing a gradient, pure black,
 *      pure white, and semi-transparent pixels (alpha 128); decode it back via
 *      an in-script inflate+unfilter decoder AND via ffmpeg; assert decoded
 *      pixels EQUAL the input exactly, alpha included.
 *   #2 determinism: encodePng(x) called twice returns byte-identical output; AND
 *      the sink source no longer references convertToBlob and DOES reference
 *      encodePng (mechanism-engaged: proves the sink actually adopted it).
 *   #3 CRC correctness: walk the produced chunks, recompute each CRC32 over
 *      (type+data), compare to the stored CRC.
 *   #4 odd dimensions + alpha: a 3×5 RGBA image with varied alpha stays valid
 *      and lossless (catches stride/row-padding bugs on non-even sizes).
 *   #5 PROVE IT CAN FAIL: flip one output byte inside IDAT and confirm the
 *      round-trip assertion trips; corrupt one CRC byte and confirm the CRC
 *      check trips. A gate that cannot fail proves nothing.
 *
 * Exit code is non-zero if ANY assertion fails.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzlibSync } from 'fflate'
import { encodePng } from '../src/export/png-encode'

// ---------------------------------------------------------------------------
// pass/fail bookkeeping
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++
    console.log(`  [PASS] ${name} — ${detail}`)
  } else {
    failed++
    console.log(`  [FAIL] ${name} — ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG decoder (colour type 6, 8-bit, no interlace) — inflate + unfilter.
// Independent of the encoder's filtering choices so it validates the real bytes.
// ---------------------------------------------------------------------------
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10]

interface Chunk {
  type: string
  data: Uint8Array
  crc: number
  crcBody: Uint8Array // type + data (what CRC is computed over)
}

function readU32(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0
}

function parseChunks(png: Uint8Array): Chunk[] {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (png[i] !== PNG_SIG[i]) throw new Error('bad PNG signature')
  }
  const chunks: Chunk[] = []
  let pos = 8
  while (pos < png.length) {
    const len = readU32(png, pos)
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7])
    const dataStart = pos + 8
    const data = png.subarray(dataStart, dataStart + len)
    const crc = readU32(png, dataStart + len)
    const crcBody = png.subarray(pos + 4, dataStart + len) // type + data
    chunks.push({ type, data, crc, crcBody: crcBody.slice() })
    pos = dataStart + len + 4
    if (type === 'IEND') break
  }
  return chunks
}

// CRC32 (independent reimplementation — do not import the encoder's).
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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

interface Decoded {
  width: number
  height: number
  bitDepth: number
  colorType: number
  rgba: Uint8Array
}

function decodePng(png: Uint8Array): Decoded {
  const chunks = parseChunks(png)
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr) throw new Error('no IHDR')
  const width = readU32(ihdr.data, 0)
  const height = readU32(ihdr.data, 4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`unexpected IHDR depth=${bitDepth} colorType=${colorType}`)

  const idatParts = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)
  const totalIdat = idatParts.reduce((n, p) => n + p.length, 0)
  const idat = new Uint8Array(totalIdat)
  let o = 0
  for (const p of idatParts) {
    idat.set(p, o)
    o += p.length
  }
  const raw = unzlibSync(idat) // zlib-wrapped → inflate

  const bpp = 4
  const stride = width * bpp
  const rgba = new Uint8Array(width * height * bpp)
  let inPos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++]
    const rowStart = y * stride
    const prevStart = rowStart - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[inPos++]
      const a = i >= bpp ? rgba[rowStart + i - bpp] : 0
      const b = y > 0 ? rgba[prevStart + i] : 0
      const c = y > 0 && i >= bpp ? rgba[prevStart + i - bpp] : 0
      let val: number
      switch (filter) {
        case 0:
          val = x
          break
        case 1:
          val = x + a
          break
        case 2:
          val = x + b
          break
        case 3:
          val = x + ((a + b) >> 1)
          break
        case 4:
          val = x + paeth(a, b, c)
          break
        default:
          throw new Error(`bad filter type ${filter} on row ${y}`)
      }
      rgba[rowStart + i] = val & 0xff
    }
  }
  return { width, height, bitDepth, colorType, rgba }
}

function eq(a: Uint8Array, b: Uint8Array | Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// test fixtures
// ---------------------------------------------------------------------------

/** A width×height RGBA buffer mixing gradient, pure black, pure white, semi-alpha. */
function makeFixture(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  let p = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (idx % 7 === 0) {
        // pure black, opaque
        rgba[p] = 0
        rgba[p + 1] = 0
        rgba[p + 2] = 0
        rgba[p + 3] = 255
      } else if (idx % 7 === 1) {
        // pure white, opaque
        rgba[p] = 255
        rgba[p + 1] = 255
        rgba[p + 2] = 255
        rgba[p + 3] = 255
      } else if (idx % 7 === 2) {
        // semi-transparent (alpha 128), coloured
        rgba[p] = 200
        rgba[p + 1] = 50
        rgba[p + 2] = 120
        rgba[p + 3] = 128
      } else if (idx % 7 === 3) {
        // fully transparent but with non-zero colour (straight-alpha must keep it)
        rgba[p] = 17
        rgba[p + 1] = 200
        rgba[p + 2] = 33
        rgba[p + 3] = 0
      } else {
        // gradient
        rgba[p] = (x * 255) / Math.max(1, width - 1)
        rgba[p + 1] = (y * 255) / Math.max(1, height - 1)
        rgba[p + 2] = (x + y) & 0xff
        rgba[p + 3] = 40 + (idx % 200)
      }
      p += 4
    }
  }
  return rgba
}

function ffmpegAvailable(): string | null {
  for (const c of ['/usr/local/bin/ffmpeg', 'ffmpeg']) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' })
      return c
    } catch {
      /* try next */
    }
  }
  return null
}

/** Decode a PNG to raw RGBA via ffmpeg; returns null if unavailable/failed. */
function ffmpegDecode(ffmpeg: string, png: Uint8Array, dir: string, tag: string): Uint8Array | null {
  const inPath = join(dir, `${tag}.png`)
  const outPath = join(dir, `${tag}.raw`)
  writeFileSync(inPath, png)
  try {
    execFileSync(ffmpeg, ['-y', '-i', inPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', outPath], { stdio: 'ignore' })
  } catch {
    return null
  }
  return new Uint8Array(readFileSync(outPath))
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
function main(): number {
  console.log('verify:png-encode — deterministic PNG encoder gate\n')

  const dir = mkdtempSync(join(tmpdir(), 'png-encode-'))
  const ffmpeg = ffmpegAvailable()
  try {
    // ---- #1 round-trip lossless (in-script decoder) --------------------
    const W = 32
    const H = 24
    const src = makeFixture(W, H)
    const png = encodePng(src, W, H, { level: 6 })

    const dec = decodePng(png)
    check(
      'roundtrip-dims',
      dec.width === W && dec.height === H && dec.bitDepth === 8 && dec.colorType === 6,
      `decoded ${dec.width}x${dec.height} depth=${dec.bitDepth} colorType=${dec.colorType} (want ${W}x${H}/8/6)`,
    )
    check('roundtrip-lossless', eq(dec.rgba, src), `${dec.rgba.length} bytes decoded == input exactly (incl. alpha)`)

    // ---- #1b round-trip via ffmpeg (independent decoder) --------------
    if (ffmpeg) {
      const raw = ffmpegDecode(ffmpeg, png, dir, 'rt')
      check(
        'roundtrip-ffmpeg',
        raw !== null && eq(raw, src),
        raw === null ? 'ffmpeg decode failed' : `ffmpeg rawvideo rgba (${raw.length} bytes) == input exactly`,
      )
    } else {
      // ffmpeg is expected at /usr/local/bin per environment; if truly absent the
      // in-script decoder still covers losslessness. Note it rather than fail.
      console.log('  [NOTE] ffmpeg not found — skipping cross-decoder check (in-script decoder still ran)')
    }

    // ---- #2 determinism -------------------------------------------------
    const a = encodePng(src, W, H, { level: 6 })
    const b = encodePng(src, W, H, { level: 6 })
    check('determinism-bytes', eq(a, b), `two encodePng() calls byte-identical (${a.length} bytes each)`)

    const sinkSrc = readFileSync(new URL('../src/export/sinks/png-sequence.ts', import.meta.url), 'utf8')
    const usesConvertToBlob = /convertToBlob/.test(sinkSrc)
    const usesEncodePng = /encodePng\s*\(/.test(sinkSrc)
    check(
      'sink-adopts-encoder',
      !usesConvertToBlob && usesEncodePng,
      `png-sequence.ts: convertToBlob absent=${!usesConvertToBlob}, encodePng() present=${usesEncodePng}`,
    )

    // ---- #3 CRC correctness --------------------------------------------
    const chunks = parseChunks(png)
    let crcOk = true
    const crcDetails: string[] = []
    for (const c of chunks) {
      const recomputed = crc32(c.crcBody)
      if (recomputed !== c.crc) {
        crcOk = false
        crcDetails.push(`${c.type}: stored=${c.crc.toString(16)} recomputed=${recomputed.toString(16)}`)
      }
    }
    const hasStructure =
      chunks.length >= 3 &&
      chunks[0].type === 'IHDR' &&
      chunks.some((c) => c.type === 'IDAT') &&
      chunks[chunks.length - 1].type === 'IEND'
    check(
      'crc-correct',
      crcOk && hasStructure,
      crcOk
        ? `all ${chunks.length} chunk CRCs valid; structure IHDR…IDAT…IEND present`
        : `CRC mismatch: ${crcDetails.join('; ')}`,
    )

    // ---- #4 odd dimensions + alpha -------------------------------------
    const ow = 3
    const oh = 5
    const osrc = makeFixture(ow, oh)
    const opng = encodePng(osrc, ow, oh, { level: 9 })
    const odec = decodePng(opng)
    let oddCrcOk = true
    for (const c of parseChunks(opng)) if (crc32(c.crcBody) !== c.crc) oddCrcOk = false
    check(
      'odd-dims-lossless',
      odec.width === ow && odec.height === oh && eq(odec.rgba, osrc) && oddCrcOk,
      `3x5 varied-alpha image: valid + lossless + CRCs ok (level 9)`,
    )

    // ---- #5 PROVE IT CAN FAIL ------------------------------------------
    // (a) flip one byte inside IDAT → decode must NOT match the source.
    const idatChunk = parseChunks(png).find((c) => c.type === 'IDAT')!
    // Locate that IDAT's data region within the full PNG buffer and flip a byte.
    // Find the IDAT length/type header offset by re-walking.
    let flipTripped = false
    {
      const corrupt = png.slice()
      // Walk to the first IDAT data byte offset.
      let pos = 8
      let idatDataOff = -1
      while (pos < corrupt.length) {
        const len = readU32(corrupt, pos)
        const type = String.fromCharCode(corrupt[pos + 4], corrupt[pos + 5], corrupt[pos + 6], corrupt[pos + 7])
        if (type === 'IDAT') {
          idatDataOff = pos + 8 + Math.floor(len / 2) // a byte in the middle of the deflate stream
          break
        }
        pos = pos + 8 + len + 4
      }
      if (idatDataOff < 0) throw new Error('could not locate IDAT to perturb')
      corrupt[idatDataOff] ^= 0xff
      try {
        const bad = decodePng(corrupt)
        flipTripped = !eq(bad.rgba, src) // decoded pixels differ → assertion would trip
      } catch {
        flipTripped = true // decode threw (inflate/adler error) → also a trip
      }
    }
    check(
      'fail-proof-idat-flip',
      flipTripped,
      `flipping one IDAT byte breaks the round-trip (idat was ${idatChunk.data.length} bytes) — the lossless gate CAN fail`,
    )

    // (b) corrupt one CRC byte → the CRC check must trip.
    let crcTripped = false
    {
      const corrupt = png.slice()
      // Corrupt IHDR's CRC (last of its 4 CRC bytes): IHDR data is 13 bytes, so
      // its chunk occupies [8 .. 8+4+4+13+4). CRC is the final 4 bytes.
      const ihdrCrcEnd = 8 + 4 + 4 + 13 + 4
      corrupt[ihdrCrcEnd - 1] ^= 0x01
      for (const c of parseChunks(corrupt)) {
        if (crc32(c.crcBody) !== c.crc) crcTripped = true
      }
    }
    check('fail-proof-crc', crcTripped, 'corrupting one CRC byte trips the CRC check — the CRC gate CAN fail')

    console.log(`\n  ${passed} passed, ${failed} failed`)
    console.log(failed === 0 ? '\nPNG-ENCODE: PASS' : '\nPNG-ENCODE: FAIL')
    return failed === 0 ? 0 : 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

process.exit(main())
