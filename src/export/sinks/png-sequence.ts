/**
 * PNG sequence sink (fflate zip of straight-alpha PNGs) — STREAMED, PARALLEL.
 *
 * The PRIMARY path (`addFrameRaw`, the engine's fast path — see
 * `export-engine.ts`) hands each frame's raw straight-alpha RGBA straight to a
 * `PngEncodePool` (`../png-encode-pool.ts`): a pool of workers, each running its
 * own oxipng (single-threaded) encoder off one shared compiled WASM module.
 * Frames fan out across workers and encode in parallel, but `onEncoded(index,
 * png)` fires in STRICT ascending frame order, so entries stream into the zip
 * in the same order a serial run would produce, with byte-identical output
 * (same oxipng L0 encoder either way).
 *
 * FALLBACK: if workers or WASM are unavailable, `createPngEncodePool` resolves
 * null and `addFrameRaw` encodes inline instead — serial `encodePngWasm`
 * (oxipng L0, same encoder as the pool) when WASM loaded, else the pure-JS
 * fflate `encodePng` when WASM itself can't load (CSP/blocked/unsupported
 * host). The export NEVER fails just because workers or WASM didn't load.
 *
 * `addFrame` (the `VideoFrame` path) is kept as a fallback for any caller that
 * doesn't use `addFrameRaw`: it draws to an `OffscreenCanvas`, reads back
 * straight-alpha RGBA with `getImageData`, and encodes with the same
 * WASM-or-fflate choice. Both encoders avoid the browser's native
 * canvas-to-PNG blob, whose deflate strength varies by engine (Chrome ~2×
 * larger than Safari for the same pixels), so frame sizes stay consistent.
 * The canvas keeps straight alpha and PNG is lossless (colour type 6), so no
 * colour or alpha data is lost. Frames are zipped with fflate's streaming
 * `Zip` at pass-through level (`ZipPassThrough`): PNG is already
 * deflate-compressed internally, so re-compressing the zip entries would only
 * spend CPU for no size benefit.
 *
 * Streaming: the OLD code kept every PNG in a `frames[]` array and built one
 * giant zip `Uint8Array` in `finish()` — the exact OOM this rework removes. Now
 * each frame is pushed into the streaming `Zip` and DROPPED; the only bytes
 * retained at any moment are the current frame's PNG (times the pool's
 * outstanding-frame window, on the parallel path). Zip output chunks flow
 * straight into the destination `writable`, serialised through a promise chain
 * so backpressure is respected and chunk order is preserved (fflate's `ondata`
 * is synchronous but `writer.write` is async).
 */

import { Zip, ZipPassThrough } from 'fflate'
import { encodePng } from '../png-encode'
import { encodePngWasm, initPngWasm } from '../png-encode-wasm'
import { createPngEncodePool, type PngEncodePool } from '../png-encode-pool'
import type { FrameSink, SinkOpts } from '../frame-sink'

export function makePngSequenceSink(): FrameSink {
  let o!: SinkOpts
  // Frame entry name inside the zip: <baseName>_<NNNNN>.png. baseName carries the
  // user's file name + baked settings (e.g. reveal_1920x1080_30fps_20260824);
  // absent → 'frame' so a caller that doesn't set it still gets valid names.
  const frameEntryName = (index: number): string =>
    `${o.baseName || 'frame'}_${String(index).padStart(5, '0')}.png`
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
  let pool: PngEncodePool | null = null

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
      // Defensive: dispose any stale pool left behind by a prior aborted run
      // that didn't clean up, before this run creates its own.
      pool?.dispose()
      pool = null
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
      console.info(`[export] png-sequence: encoder = ${useWasm ? 'oxipng (WASM)' : 'fflate (pure-JS fallback)'}`)

      // Parallel encode pool: fans frames across workers, each an oxipng ST
      // encoder off one shared compiled module. onEncoded is called in STRICT
      // frame order, so entries stream into the zip in order. Null → workers or
      // WASM unavailable → serial inline encode in addFrameRaw (below).
      const poolSize = Math.max(1, Math.min((navigator.hardwareConcurrency ?? 4) - 1, 8))
      pool = await createPngEncodePool({
        poolSize,
        onEncoded: async (index: number, png: Uint8Array) => {
          if (zipError) throw zipError
          const e = new ZipPassThrough(frameEntryName(index))
          zip.add(e)
          e.push(png, true)
          // Same disk backpressure as the serial path: awaiting the write queue
          // here throttles the pool's flush → its submit() → the engine loop.
          await queue
          if (zipError) throw zipError
        },
      })
      console.info(`[export] png-sequence: ${pool ? `pool (${poolSize} workers)` : 'serial'} encode`)
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
      const e = new ZipPassThrough(frameEntryName(n++))
      zip.add(e)
      e.push(data, true)

      // Backpressure: `e.push` fires fflate's sync `ondata`, which appends this
      // frame's chunk write(s) to `queue`. Await the queue tail so a slow disk
      // writer throttles the engine's frame loop instead of the encoder racing
      // ahead and buffering an unbounded number of pending PNG writes in memory.
      await queue
      if (zipError) throw zipError
    },

    async addFrameRaw(rgba: Uint8ClampedArray, width: number, height: number, index: number) {
      if (zipError) throw zipError
      if (pool) {
        // Pool delivers to onEncoded in order; submit() backpressures on the window.
        await pool.submit(index, rgba, width, height)
        return
      }
      // Fallback: encode inline in order (index is monotonic 0..N-1).
      const data = useWasm ? await encodePngWasm(rgba, width, height) : encodePng(rgba, width, height, { level: 6 })
      const e = new ZipPassThrough(frameEntryName(index))
      zip.add(e)
      e.push(data, true)
      await queue
      if (zipError) throw zipError
    },

    async finish() {
      // Wait for every submitted frame to be encoded AND written in order.
      await pool?.drain()
      // Signal no more files; fflate emits the central directory + final chunk.
      zip.end()
      // Wait for every queued write (including the final chunk) to flush.
      await queue
      if (zipError) throw zipError
      await writer.close()
      // Successful export: drain() already flushed every frame, so nothing is
      // pending. Dispose the pool now — without this, a sink reused for the
      // app's lifetime (see sinks/index.ts) would leak up to `poolSize` live
      // worker+WASM instances per successful export (abort() only runs when
      // the engine's finally sees a NON-clean finish).
      pool?.dispose()
      pool = null
    },

    async abort() {
      // begin() never ran → nothing to tear down.
      if (!begun) return
      pool?.dispose()
      pool = null
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
