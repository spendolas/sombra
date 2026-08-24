/**
 * Deterministic offline export engine — the integration hub of client-side
 * video export.
 *
 * Recompiles the CURRENT graph fresh (the RenderPlan is never stored — see
 * reference sheet §5), then renders `duration * fps` frames offscreen via the
 * export renderer (Task 2), driving `u_time = i / fps` — no wall clock, no
 * `Math.random()` — and pushes each frame to a `FrameSink` (Tasks 3 + 5),
 * sized/framed per Task 6's `computeFraming` output. `runExport` is what
 * Task 7's export modal calls.
 *
 * The engine acquires and OWNS a dedicated `GPUDevice` for the lifetime of one
 * export: unlike the app's shared main-renderer device, this one is created
 * here and destroyed here (`ExportRenderTarget.dispose()` deliberately never
 * destroys it, since in the app it's normally shared).
 */

import { compileGraph } from '../compiler/glsl-generator'
import { compileGraphIR } from '../compiler/ir-compiler'
import { useGraphStore } from '../stores/graphStore'
import { createExportRenderTarget, type ExportRenderTarget } from './export-renderer'
import { decodeGraphImages } from './export-images'
import type { FrameSink, QualityLevel } from './frame-sink'
import type { FramingChoice } from './framing'
import type { ExportDestination } from './export-destination'

export interface ExportJob {
  sink: FrameSink
  width: number
  height: number
  fps: number
  durationSec: number
  alpha: boolean
  matte?: string
  quality: QualityLevel
  framing: FramingChoice
}

/**
 * Export lifecycle phase surfaced to the UI. The frame loop reports `'rendering'`
 * (the implicit default when `onProgress` omits the phase); once the last frame
 * is queued the engine flips to `'finalizing'` so the modal can show
 * "Finalizing…" (mux flush) / "Zipping…" (PNG zip central-directory) — these can
 * take a while on large exports and would otherwise look like a frozen 100% bar.
 */
export type ExportPhase = 'rendering' | 'finalizing'

/** What a completed export reports back — mirrors `ExportDestination.finalize()`. */
export interface ExportResult {
  blob: Blob | null
  savedToDisk: boolean
  filename: string
}

export async function runExport(
  job: ExportJob,
  destination: ExportDestination,
  onProgress: (frame: number, total: number, phase?: ExportPhase) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  // ---------------------------------------------------------------------
  // Step 1: fresh RenderPlan from the CURRENT graph (both codegen paths,
  // kept in parity — mirrors compiler.worker.ts's `useIR` branch verbatim).
  // ---------------------------------------------------------------------
  const { nodes, edges } = useGraphStore.getState()
  const plan = compileGraph(nodes, edges)
  if (!plan.success) {
    throw new Error('[export] compile failed: ' + plan.errors.map((e) => e.message).join('; '))
  }
  const ir = compileGraphIR(nodes, edges)
  if (!ir) {
    throw new Error('[export] IR compile returned null')
  }
  plan.wgsl = { passes: ir.passes }

  // ---------------------------------------------------------------------
  // Acquire a dedicated GPUDevice for this export. v1 is WebGPU-only.
  // ---------------------------------------------------------------------
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) {
    throw new Error('[export] WebGPU unavailable — export requires WebGPU (v1)')
  }
  const device = await adapter.requestDevice()

  // Decode the graph's images so image samplers export the real texture.
  const images = await decodeGraphImages(nodes)

  const total = Math.max(1, Math.round(job.durationSec * job.fps))
  let target: ExportRenderTarget | undefined

  // Video codecs reject ODD dimensions: mediabunny reports a codec NOT encodable
  // when width or height is odd, and the sink then silently falls through. Clamp
  // to even (round DOWN, min 2) HERE so the render target and the sink both see
  // the exact same even dims — no half-pixel mismatch between what we rasterise
  // and what we encode. (The modal already rounds up to even; this is the
  // defensive floor for any other caller. PNG is unaffected either way.)
  const evenFloor = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
  const width = evenFloor(job.width)
  const height = evenFloor(job.height)

  // Tracks whether the sink reached a clean `finish()` (which closes the
  // writable). If we bail before that, the `finally` calls `sink.abort()`.
  // Each sink locks the destination writable via `getWriter()` in `begin()`, so
  // only the sink can release it — `sink.abort()` stops the encoder AND releases
  // its own writer + aborts the destination writable. That makes mid-encode
  // Cancel tear down DETERMINISTICALLY: on the File System Access path the abort
  // discards the swap file instead of leaking its handle to GC (and the user's
  // chosen file is untouched until `close()`, so a cancelled disk export never
  // corrupts it). `sink.abort()` is a safe no-op before `begin()`.
  let finished = false

  try {
    target = createExportRenderTarget(device, plan, width, height, images)

    await job.sink.begin(
      {
        width,
        height,
        fps: job.fps,
        alpha: job.alpha,
        matte: job.matte,
        quality: job.quality,
      },
      destination.writable,
    )

    // -----------------------------------------------------------------
    // Step 2: the offline loop. No wall-clock — u_time is driven solely
    // by i / fps, so identical graph + settings always produce identical
    // output (the `random` node and all animation are functions of
    // uniforms, not Date.now()).
    // -----------------------------------------------------------------
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

      const t = i / job.fps
      target.renderFrame({
        timeSec: t,
        frameScale: job.framing.frameScale,
        uDpr: job.framing.dpr,
        anchor: job.framing.anchor,
      })

      // REQUIRED before toVideoFrame(): the render target throws on a stale
      // readback guard otherwise — readback() populates (and tags) the
      // pixels toVideoFrame() reuses.
      const rgba = await target.readback()
      const timestampUs = Math.round(t * 1e6)
      if (job.sink.addFrameRaw) {
        // Fast path: hand raw RGBA straight to the sink (PNG pool). readback()
        // returns a FRESH Uint8ClampedArray each call, so the sink/pool may
        // transfer its buffer — nothing else reads it after this.
        // IMPORTANT: because the buffer may be TRANSFERRED (not copied) into a
        // worker, `target`'s internal `lastPixels` can end up detached after this
        // call. `toVideoFrame()` must NOT be called for this frame afterward —
        // the render target's staleness guard only checks the readback
        // generation counter, not whether the underlying buffer is detached, so
        // it would not catch a read of a detached buffer here.
        await job.sink.addFrameRaw(rgba, width, height, i, timestampUs)
      } else {
        const vf = target.toVideoFrame(timestampUs)
        await job.sink.addFrame(vf, timestampUs)
        vf.close()
      }

      onProgress(i + 1, total)
    }

    // Rendering done; the mux finalize / PNG zip flush below can be slow on large
    // exports, so signal the finalize phase before we hand off to the sink.
    onProgress(total, total, 'finalizing')

    // Sink flushes and closes the writable. Bytes have streamed out already —
    // no Blob returned; the ExportDestination reports the outcome.
    await job.sink.finish()
    finished = true

    // Reports the outcome (fallback Blob, or savedToDisk on the disk path); does
    // NOT re-close the stream (finish() already did).
    return await destination.finalize()
  } finally {
    // If we didn't reach a clean finish(), tear the sink down deterministically:
    // sink.abort() stops the encoder, releases the sink's own writer, and aborts
    // the destination writable (discarding a partial file / FSA swap handle).
    // Best-effort — never mask the original error (e.g. the AbortError).
    if (!finished) {
      try {
        await job.sink.abort()
      } catch {
        /* teardown is best-effort; the original error is what propagates */
      }
    }
    // Release GPU resources on success, mid-loop throw, AND abort alike.
    target?.dispose()
    device.destroy()
  }
}
