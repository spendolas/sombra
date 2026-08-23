/**
 * Live WYSIWYG export preview. Renders the CURRENT graph through the export
 * renderer (Task 2) at the export's framing, into a small 2D canvas, on a
 * wall-clock rAF loop. Straight-alpha readback is drawn with `putImageData`
 * (replace, no blend) so transparent pixels reveal whatever sits behind the
 * canvas (the checker for alpha sinks, the matte for opaque ones) — matching
 * what the export produces. It renders an actual export frame, so the preview
 * is WYSIWYG by construction.
 *
 * Ref-driven: the caller passes a ref it updates every render. This keeps the
 * hook unconditional (it can run before the modal's `if (!open) return null`)
 * and lets the single rAF loop react to size / framing / active changes without
 * tearing down the GPUDevice.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import { compileGraph } from '@/compiler/glsl-generator'
import { compileGraphIR } from '@/compiler/ir-compiler'
import { createExportRenderTarget, type ExportRenderTarget } from './export-renderer'
import { decodeGraphImages } from './export-images'
import type { FramingChoice } from './framing'

/** Longest edge of the preview's backing buffer (px). Small — it's a thumbnail. */
const PREVIEW_LONG_EDGE = 480

export interface ExportPreviewState {
  active: boolean
  outW: number
  outH: number
  framing: FramingChoice
  exportW: number
}

function previewDims(outW: number, outH: number): { pw: number; ph: number } {
  if (outW <= 0 || outH <= 0) return { pw: 2, ph: 2 }
  const scale = PREVIEW_LONG_EDGE / Math.max(outW, outH)
  return { pw: Math.max(2, Math.round(outW * scale)), ph: Math.max(2, Math.round(outH * scale)) }
}

export function useExportPreview(
  canvas: RefObject<HTMLCanvasElement | null>,
  state: RefObject<ExportPreviewState>,
  /**
   * Called (on change) with whether the shader's output is ever translucent —
   * read straight off the frame pixels we already read back, so no extra render
   * or device. A colour-typed source (hsv_to_rgb, blur…) can't be told apart
   * from a transparent one by graph type alone; only the pixels can. Sticky
   * toward `true`: any translucent frame latches it, catching a shader that only
   * goes translucent partway through its animation.
   */
  onHasAlpha?: (hasAlpha: boolean) => void,
): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return
    let disposed = false
    let raf = 0
    let device: GPUDevice | undefined
    let target: ExportRenderTarget | undefined
    let targetW = 0
    let targetH = 0
    let reportedAlpha: boolean | null = null
    let loggedError = false
    const start = performance.now()

    void (async () => {
      const { nodes, edges } = useGraphStore.getState()
      const plan = compileGraph(nodes, edges)
      if (!plan.success) return
      const ir = compileGraphIR(nodes, edges)
      if (!ir) return
      plan.wgsl = { passes: ir.passes }

      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter || disposed) return
      device = await adapter.requestDevice()
      if (disposed) { device.destroy(); return }

      // Decode the graph's images once (async), so image samplers render the
      // real texture rather than a transparent dummy.
      const images = await decodeGraphImages(nodes)
      if (disposed) { device.destroy(); return }

      const cv = canvas.current
      const ctx = cv?.getContext('2d', { alpha: true }) ?? null

      const loop = async (): Promise<void> => {
        if (disposed) return
        const s = state.current
        if (s && s.active && ctx && device) {
          const { pw, ph } = previewDims(s.outW, s.outH)
          try {
            if (!target || pw !== targetW || ph !== targetH) {
              target?.dispose()
              target = createExportRenderTarget(device, plan, pw, ph, images)
              targetW = pw
              targetH = ph
              if (cv) { cv.width = pw; cv.height = ph }
            }
            // Same visible framing as the export at fewer pixels: frameScale scales
            // with the resolution ratio (correct for Reveal, where frameScale = 1).
            // Density (dpr) passes through unscaled. (Task 9 rewrites this hook.)
            const frameScale = s.framing.frameScale * (pw / Math.max(1, s.exportW))
            target.renderFrame({
              timeSec: (performance.now() - start) / 1000, // live wall-clock (preview only)
              frameScale,
              uDpr: s.framing.dpr,
              anchor: s.framing.anchor,
            })
            const px = await target.readback()
            if (disposed) return
            ctx.putImageData(new ImageData(px, pw, ph), 0, 0)
            // Detect translucency from the readback (alpha = every 4th byte).
            // Only scan until we've latched `true` (sticky).
            if (onHasAlpha && reportedAlpha !== true) {
              let translucent = false
              for (let i = 3; i < px.length; i += 4) {
                if (px[i] < 250) {
                  translucent = true
                  break
                }
              }
              if (translucent !== reportedAlpha) {
                reportedAlpha = translucent
                onHasAlpha(translucent)
              }
            }
          } catch (e) {
            // Don't let a render/readback failure kill the loop silently (a
            // swallowed throw here left the preview blank with no clue why).
            if (!loggedError) {
              loggedError = true
              console.warn('[export-preview] render failed:', e instanceof Error ? e.message : e)
            }
          }
        }
        if (!disposed) raf = requestAnimationFrame(() => void loop())
      }
      raf = requestAnimationFrame(() => void loop())
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      target?.dispose()
      device?.destroy()
    }
  }, [canvas, state, onHasAlpha])
}
