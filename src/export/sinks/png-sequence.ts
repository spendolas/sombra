/**
 * PNG sequence sink (fflate zip of straight-alpha PNGs) — STREAMED.
 *
 * Each `VideoFrame` is drawn to an `OffscreenCanvas` and encoded natively via
 * `convertToBlob({ type: 'image/png' })` — the canvas keeps straight alpha, and
 * PNG is lossless, so no colour or alpha data is lost. Frames are zipped with
 * fflate's streaming `Zip` at pass-through level (`ZipPassThrough`): PNG is
 * already deflate-compressed internally, so re-compressing the zip entries would
 * only spend CPU for no size benefit.
 *
 * Streaming: the OLD code kept every PNG in a `frames[]` array and built one
 * giant zip `Uint8Array` in `finish()` — the exact OOM this rework removes. Now
 * each frame is pushed into the streaming `Zip` and DROPPED; the only bytes
 * retained at any moment are the current frame's PNG. Zip output chunks flow
 * straight into the destination `writable`, serialised through a promise chain
 * so backpressure is respected and chunk order is preserved (fflate's `ondata`
 * is synchronous but `writer.write` is async).
 */

import { Zip, ZipPassThrough } from 'fflate'
import type { FrameSink, SinkOpts } from '../frame-sink'

export function makePngSequenceSink(): FrameSink {
  let o!: SinkOpts
  let cv!: OffscreenCanvas
  let ctx!: OffscreenCanvasRenderingContext2D
  let n = 0
  let zip!: Zip
  let writer!: WritableStreamDefaultWriter<Uint8Array>
  // Serialises async writer.write calls against fflate's sync ondata callback,
  // preserving chunk order and propagating backpressure.
  let queue: Promise<void> = Promise.resolve()
  let zipError: unknown = null

  return {
    id: 'png-sequence',
    label: 'PNG sequence',
    supportsAlpha: true,
    output: 'zip',
    tier: 'free',
    fileExt: 'zip',
    mimeType: 'application/zip',

    async isSupported() {
      return typeof OffscreenCanvas !== 'undefined'
    },

    async begin(opts, writable) {
      o = opts
      n = 0
      queue = Promise.resolve()
      zipError = null
      writer = writable.getWriter()

      zip = new Zip((err, chunk, final) => {
        if (err) {
          zipError = err
          return
        }
        // Chain each write; a captured chunk is dropped as soon as it's written.
        queue = queue.then(() => writer.write(chunk))
        if (final) {
          // The last chunk's write completing means the whole zip is flushed;
          // finish() awaits `queue` after end() to observe this.
        }
      })

      cv = new OffscreenCanvas(opts.width, opts.height)
      const context = cv.getContext('2d')
      if (!context) throw new Error('[export] png-sequence: OffscreenCanvas 2D context unavailable')
      ctx = context
    },

    async addFrame(vf) {
      if (zipError) throw zipError
      ctx.clearRect(0, 0, o.width, o.height)
      ctx.drawImage(vf, 0, 0)
      const blob = await cv.convertToBlob({ type: 'image/png' })
      const data = new Uint8Array(await blob.arrayBuffer())

      // Stream this PNG into the zip and DROP it — never retained in an array.
      const e = new ZipPassThrough(`frame_${String(n++).padStart(5, '0')}.png`)
      zip.add(e)
      e.push(data, true)
    },

    async finish() {
      // Signal no more files; fflate emits the central directory + final chunk.
      zip.end()
      // Wait for every queued write (including the final chunk) to flush.
      await queue
      if (zipError) throw zipError
      await writer.close()
    },
  }
}
