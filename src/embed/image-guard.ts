/**
 * Image data-URL guard (security audit F4 + image-size bomb).
 *
 * Every image the editor, viewer and player loads is `img.src = <data URL>` taken
 * straight from untrusted graph/artifact JSON. Two problems:
 *  1. The value can be ANY URL (a tracking beacon / mixed-content fetch). On
 *     sombra.sh the CSP blocks that; the embed player runs on third-party pages
 *     where our CSP does not apply.
 *  2. A tiny compressed image can DECLARE enormous dimensions; small data URLs skip
 *     the editor's downscale pass and reach the GPU at full size.
 * So: accept only base64 png/jpeg/webp/gif data URLs, read the declared size from
 * the file header BEFORE any decode, and refuse anything oversize or unparseable.
 *
 * Lives in src/embed/ (the player bundle may import only src/renderer, src/embed, pako).
 */

export const MAX_IMAGE_EDGE = 16384
export const MAX_IMAGE_PIXELS = 8192 * 8192
// Generous on purpose: real old .sombra files embed multi-MB PNG sources (one shipped
// graph carries a 67.7M-character image); the editor downscales those on load. The
// dimension limits below, not this, are what stop a decode bomb.
export const MAX_IMAGE_DATAURL_CHARS = 96 * 1024 * 1024

const DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,/

function b64Prefix(b64: string, byteCount: number): Uint8Array | null {
  const chars = Math.ceil((byteCount * 4) / 3) + 4
  let s = b64.slice(0, chars).replace(/-/g, '+').replace(/_/g, '/')
  s = s.slice(0, s.length - (s.length % 4))
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch { return null }
}

/** Declared pixel size from the container header, or null if it can't be read. */
export function peekImageSize(mime: string, b: Uint8Array): { w: number; h: number } | null {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
  if (mime === 'png') {
    if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null
    return { w: u32(16), h: u32(20) }
  }
  if (mime === 'gif') {
    if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49) return null
    return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) }
  }
  if (mime === 'webp') {
    if (b.length < 30 || b[0] !== 0x52 || b[8] !== 0x57) return null
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (tag === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
    if (tag === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff }
    if (tag === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
    }
    return null
  }
  if (mime === 'jpeg') {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]
      if (m === 0xff) { i++; continue }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] }
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3])
    }
    return null
  }
  return null
}

export function checkImageDataUrl(url: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof url !== 'string') return { ok: false, reason: 'not a string' }
  if (url.length > MAX_IMAGE_DATAURL_CHARS) return { ok: false, reason: 'too large' }
  const m = DATA_URL_RE.exec(url)
  if (!m) return { ok: false, reason: 'not a base64 png/jpeg/webp/gif data URL' }
  const head = b64Prefix(url.slice(m[0].length), 512 * 1024)
  const size = head ? peekImageSize(m[1], head) : null
  if (!size) return { ok: false, reason: 'unreadable image header' }
  if (size.w < 1 || size.h < 1) return { ok: false, reason: 'empty image' }
  if (size.w > MAX_IMAGE_EDGE || size.h > MAX_IMAGE_EDGE) return { ok: false, reason: `edge over ${MAX_IMAGE_EDGE}px` }
  if (size.w * size.h > MAX_IMAGE_PIXELS) return { ok: false, reason: 'too many pixels' }
  return { ok: true }
}

export function isSafeImageDataUrl(url: unknown): url is string {
  return checkImageDataUrl(url).ok
}
