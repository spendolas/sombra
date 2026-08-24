/**
 * PNG sequence sink (fflate zip of straight-alpha PNGs) — STREAMED.
 *
 * Each `VideoFrame` is drawn to an `OffscreenCanvas`, its raw straight-alpha
 * RGBA is read back with `getImageData`, and encoded to PNG. The PRIMARY encoder
 * is `@jsquash/png` (WASM, via `encodePngWasm`): it does the whole encode
 * (filtering + deflate) in WebAssembly ~20–30× faster than our pure-JS encoder
 * AND is deterministic (byte-identical across browsers). If the WASM can't load
 * (CSP/blocked/unsupported host), `begin()` sets a flag and every frame falls
 * back to our pure-JS `encodePng` (fflate zlib) — the export NEVER fails just
 * because WASM didn't load. Both encoders avoid the browser's native
 * canvas-to-PNG blob, whose deflate strength varies by engine (Chrome ~2× larger
 * than Safari for the same pixels), so frame sizes stay consistent. The canvas
 * keeps straight alpha and PNG is lossless (colour type 6), so no colour or alpha
 * data is lost. Frames are zipped with
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
import { encodePng } from '../png-encode'
import { encodePngWasm, initPngWasm } from '../png-encode-wasm'
import type { FrameSink, SinkOpts } from '../frame-sink'

export function makePngSequenceSink(): FrameSink {
  let o!: SinkOpts
  let cv!: OffscreenCanvas
  let ctx!: OffscreenCanvasRenderingContext2D
  let n = 0
  let zip!: Zip
  let writer!: WritableStreamDefaultWriter<Uint8Array>
  let dest!: WritableStream<Uint8Array>
  // Serialises async writer.write calls against fflate's sync ondata callback,
  // preserving chunk order and propagating backpressure.
  let queue: Promise<void> = Promise.resolve()
  let zipError: unknown = null
  // begin() ran → the zip + writer exist and must be torn down on abort.
  let begun = false
  // Encoder path chosen in begin(): WASM (@jsquash) when it loaded, else fflate.
  let useWasm = false

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
      dest = writable
      writer = writable.getWriter()
      // Set the teardown guard ATOMICALLY with lock acquisition — the very next
      // statement after getWriter(), before anything throwable (Zip ctor,
      // getContext). If begin() throws past this point, the engine's finally →
      // abort() still releases the lock + aborts the destination.
      begun = true

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

      // Compile the WASM encoder ONCE (memoised across exports). If it can't load
      // — CSP, blocked fetch, unsupported host — degrade to the pure-JS encoder
      // rather than failing the export. Log the chosen path once per export.
      useWasm = await initPngWasm()
      console.info(`[export] png-sequence: encoder = ${useWasm ? '@jsquash (WASM)' : 'fflate (pure-JS fallback)'}`)
    },

    async addFrame(vf) {
      if (zipError) throw zipError
      ctx.clearRect(0, 0, o.width, o.height)
      ctx.drawImage(vf, 0, 0)
      // Read back straight-alpha RGBA and encode deterministically. getImageData
      // returns non-premultiplied RGBA, which is exactly PNG colour type 6, so
      // alpha round-trips without premultiply/unpremultiply error.
      const imageData = ctx.getImageData(0, 0, o.width, o.height).data
      // Primary path: WASM (@jsquash) — fast + deterministic. Fallback: fflate.
      const data = useWasm
        ? await encodePngWasm(imageData, o.width, o.height)
        : encodePng(imageData, o.width, o.height, { level: 6 })

      // Stream this PNG into the zip and DROP it — never retained in an array.
      const e = new ZipPassThrough(`frame_${String(n++).padStart(5, '0')}.png`)
      zip.add(e)
      e.push(data, true)

      // Backpressure: `e.push` fires fflate's sync `ondata`, which appends this
      // frame's chunk write(s) to `queue`. Await the queue tail so a slow disk
      // writer throttles the engine's frame loop instead of the encoder racing
      // ahead and buffering an unbounded number of pending PNG writes in memory.
      await queue
      if (zipError) throw zipError
    },

    async finish() {
      // Signal no more files; fflate emits the central directory + final chunk.
      zip.end()
      // Wait for every queued write (including the final chunk) to flush.
      await queue
      if (zipError) throw zipError
      await writer.close()
    },

    async abort() {
      // begin() never ran → nothing to tear down.
      if (!begun) return
      // Releasing the lock rejects any still-pending queued write; swallow it so
      // it never surfaces as an unhandled rejection. (In the normal cancel case
      // the frame loop awaits `queue` each frame, so it's already settled.)
      void queue.catch(() => {})
      // Stop feeding the zip (terminate any internal worker; subsequent add()
      // would fail), release the writer lock, then abort the destination
      // writable (discards the file / FSA swap handle). All best-effort.
      try {
        zip.terminate()
      } catch {
        /* already ended/terminated — best-effort */
      }
      try {
        writer.releaseLock()
      } catch {
        /* already released — best-effort */
      }
      try {
        await dest.abort()
      } catch {
        /* already closed/errored — best-effort */
      }
    },
  }
}
