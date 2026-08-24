/**
 * PNG encode worker — one @jsquash WASM encoder instance per worker.
 *
 * WHY THIS EXISTS: `encodePngWasm` (see `png-encode-wasm.ts`) is fast per frame
 * but runs on the main thread, so a long PNG-sequence export is still serial.
 * This worker lets a pool (`png-encode-pool.ts`) encode frames in PARALLEL — each
 * worker owns its own @jsquash instance, all sharing ONE compiled
 * `WebAssembly.Module` handed in at init (compiled once via
 * `compilePngWasmModule()` and structured-cloned to every worker).
 *
 * Ordered reassembly and backpressure live in the pool; this worker is stateless
 * beyond its initialised encoder and simply encodes what it is told, tagging each
 * result with the frame `id` so the pool can reorder out-of-order completions.
 *
 * Editor-side export code — NOT shipped in the embed player.
 */

import encode, { init as jsquashInit } from '@jsquash/png/encode'

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
        // @jsquash's init accepts a precompiled WebAssembly.Module — every worker
        // instantiates the SAME shared module handed in by the pool.
        await jsquashInit(msg.module)
        ctx.postMessage({ type: 'inited' })
      } catch (err) {
        ctx.postMessage({ type: 'error', error: String(err) })
      }
      break
    }
    case 'encode': {
      try {
        const image = new ImageData(new Uint8ClampedArray(msg.rgba), msg.width, msg.height)
        const out = await encode(image)
        // Transfer the PNG buffer back (zero-copy) — the pool copies out of it.
        ctx.postMessage({ type: 'done', id: msg.id, png: out }, [out])
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
