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

export async function runExport(
  job: ExportJob,
  onProgress: (frame: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
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

  try {
    target = createExportRenderTarget(device, plan, width, height, images)

    await job.sink.begin({
      width,
      height,
      fps: job.fps,
      alpha: job.alpha,
      matte: job.matte,
      quality: job.quality,
    })

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
      await target.readback()
      const timestampUs = Math.round(t * 1e6)
      const vf = target.toVideoFrame(timestampUs)
      await job.sink.addFrame(vf, timestampUs)
      vf.close()

      onProgress(i + 1, total)
    }

    return await job.sink.finish()
  } finally {
    // Release GPU resources on success, mid-loop throw, AND abort alike.
    target?.dispose()
    device.destroy()
  }
}
