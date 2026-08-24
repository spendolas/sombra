/**
 * PNG encode worker — one @jsquash/oxipng (single-threaded) WASM encoder
 * instance per worker.
 *
 * WHY THIS EXISTS: `encodePngWasm` (see `png-encode-wasm.ts`) is fast per frame
 * but runs on the main thread, so a long PNG-sequence export is still serial.
 * This worker lets a pool (`png-encode-pool.ts`) encode frames in PARALLEL — each
 * worker owns its own oxipng instance, all sharing ONE compiled
 * `WebAssembly.Module` handed in at init (compiled once via
 * `compilePngWasmModule()` and structured-cloned to every worker).
 *
 * Ordered reassembly and backpressure live in the pool; this worker is stateless
 * beyond its initialised encoder and simply encodes what it is told, tagging each
 * result with the frame `id` so the pool can reorder out-of-order completions.
 *
 * Editor-side export code — NOT shipped in the embed player.
 */

import init, { optimise_raw } from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js'
import { OXIPNG_LEVEL } from './png-encode-wasm'

// --- Message protocol (shared with png-encode-pool.ts) ---------------------

/** main → worker */
export type PngWorkerReq =
  | { type: 'init'; module: WebAssembly.Module }
  | { type: 'encode'; id: number; rgba: ArrayBuffer; width: number; height: number }
  | { type: 'close' }

/** worker → main */
export type PngWorkerRes =
  | { type: 'inited' }
  | { type: 'done'; id: number; png: ArrayBuffer }
  | { type: 'error'; id?: number; error: string }

// `self` is typed as a Window under the DOM lib; narrow it to the dedicated
// worker surface we use (one-arg postMessage + a transfer-list overload).
const ctx = self as unknown as {
  postMessage(message: PngWorkerRes, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<PngWorkerReq>) => void) | null
}

ctx.onmessage = async (event: MessageEvent<PngWorkerReq>) => {
  const msg = event.data
  switch (msg.type) {
    case 'init': {
      try {
        // oxipng's ST init accepts a precompiled WebAssembly.Module — every
        // worker instantiates the SAME shared module handed in by the pool.
        await init(msg.module)
        ctx.postMessage({ type: 'inited' })
      } catch (err) {
        ctx.postMessage({ type: 'error', error: String(err) })
      }
      break
    }
    case 'encode': {
      try {
        const data = new Uint8ClampedArray(msg.rgba)
        // optimise_raw is SYNCHRONOUS (no await) — it returns a fresh Uint8Array.
        const out = optimise_raw(data, msg.width, msg.height, OXIPNG_LEVEL, false, false)
        // optimise_raw returns a fresh tight array (byteOffset 0, byteLength ===
        // buffer.byteLength), so its buffer is safe to transfer as-is. Belt-and-
        // suspenders: copy if that ever isn't true, so we never transfer stray
        // bytes from an oversized/offset backing buffer.
        const tight = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
        const buf = tight ? out.buffer : new Uint8Array(out).buffer
        // Transfer the PNG buffer back (zero-copy) — the pool copies out of it.
        ctx.postMessage({ type: 'done', id: msg.id, png: buf }, [buf])
      } catch (err) {
        ctx.postMessage({ type: 'error', id: msg.id, error: String(err) })
      }
      break
    }
    case 'close': {
      // Best-effort self-shutdown; the pool normally terminates workers directly.
      ;(self as unknown as { close(): void }).close()
      break
    }
  }
}
