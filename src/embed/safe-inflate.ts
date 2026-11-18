/**
 * Bounded inflate. `pako.inflate` has no output limit, so a ~200 KB payload can
 * expand to hundreds of MB (measured: 1029x, 424 MB RSS) and crash the tab —
 * from a share link, a .sombra file, or a hosted embed artifact. This streams
 * the output and aborts as soon as it passes `maxBytes`, so memory stays
 * bounded by the limit plus one chunk.
 *
 * Lives in src/embed/ because the player bundle may import only
 * src/renderer/*, src/embed/* and pako.
 */
import pako from 'pako'

/** Decompressed-size ceilings. Real scenes are far below these. */
export const MAX_INFLATED_FILE_BYTES = 128 * 1024 * 1024 // .sombra file, hosted embed artifact (old files embed large image sources)
export const MAX_INFLATED_HASH_BYTES = 16 * 1024 * 1024 // share-URL hash / inline attribute
/** Ceiling on the base64 text of a hash/attribute before it is even decoded. */
export const MAX_ENCODED_HASH_CHARS = 8 * 1024 * 1024

export class InflateLimitError extends Error {
  constructor(maxBytes: number) {
    super(`Data is too large: it expands past the ${Math.round(maxBytes / 1048576)} MB limit`)
    this.name = 'InflateLimitError'
  }
}

export function safeInflate(bytes: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const inf = new pako.Inflate()
  inf.onData = (chunk: Uint8Array) => {
    total += chunk.length
    if (total > maxBytes) throw new InflateLimitError(maxBytes)
    chunks.push(chunk)
  }
  inf.push(bytes, true)
  if (inf.err) throw new Error(inf.msg || 'Invalid compressed data')
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

export function safeInflateToString(bytes: Uint8Array, maxBytes: number): string {
  return new TextDecoder().decode(safeInflate(bytes, maxBytes))
}
