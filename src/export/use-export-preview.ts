/**
 * Live WYSIWYG export preview. Renders the CURRENT graph through the export
 * renderer (Task 2) at (near) the EXPORT resolution using the REAL framing
 * values, then DOWNSCALES the readback into a small display canvas — true
 * WYSIWYG by rendering the actual thing.
 *
 * Why render big then shrink (not render small directly): feature-size nodes
 * (`dither`, `pixelate`) compute their cell in device px as
 * `max(1, floor(pixelSize * u_frame_scale + 0.5))`. Rendering a 2048px-native
 * shader into a ~480px buffer forced `frameScale` down to ~0.18, flooring the
 * dither cell to 1px: the triangle-SDF coverage collapsed and the whole image
 * blew out (mean luminance ~79 vs the correct ~16). NO uniform value can shrink
 * a ~1px-at-2048 feature into a 480px canvas correctly — the only faithful
 * preview is to rasterise at export scale and downscale the pixels.
 *
 * Straight-alpha readback is drawn with `putImageData` (replace, no blend) into
 * an offscreen buffer, then `drawImage`-downscaled (high-quality smoothing) into
 * the display canvas so transparent pixels reveal whatever sits behind it (the
 * checker for alpha sinks, the matte for opaque ones) — matching the export.
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

/** Longest edge of the small DISPLAY canvas (px). It's a thumbnail. */
const PREVIEW_LONG_EDGE = 480

/**
 * Longest edge of the RENDER backing buffer (px). The preview rasterises at the
 * export resolution capped to this for perf; never upscaled beyond the true
 * export size. Big enough that feature-size nodes keep multi-pixel cells (so the
 * preview stays a faithful proxy of the full-size export).
 */
const PREVIEW_RENDER_CAP = 1600

/** ~25fps render gate — full-res readback is heavier than the old 480px path. */
const RENDER_INTERVAL_MS = 40

export interface ExportPreviewState {
  active: boolean
  outW: number
  outH: number
  framing: FramingChoice
  exportW: number
}

/** Small display-canvas dimensions (long edge = PREVIEW_LONG_EDGE). */
function previewDims(outW: number, outH: number): { pw: number; ph: number } {
  if (outW <= 0 || outH <= 0) return { pw: 2, ph: 2 }
  const scale = PREVIEW_LONG_EDGE / Math.max(outW, outH)
  return { pw: Math.max(2, Math.round(outW * scale)), ph: Math.max(2, Math.round(outH * scale)) }
}

/**
 * Render-backing dimensions: the export size (`outW×outH`) scaled so its long
 * edge ≤ PREVIEW_RENDER_CAP, but never upscaled beyond the true export size.
 * Aspect preserved exactly.
 */
function renderDims(outW: number, outH: number): { rw: number; rh: number } {
  if (outW <= 0 || outH <= 0) return { rw: 2, rh: 2 }
  const scale = Math.min(1, PREVIEW_RENDER_CAP / Math.max(outW, outH))
  return { rw: Math.max(2, Math.round(outW * scale)), rh: Math.max(2, Math.round(outH * scale)) }
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
    // Reused offscreen buffer holding the full-res straight-alpha readback; the
    // display canvas is a high-quality downscale of it.
    let offscreen: OffscreenCanvas | undefined
    let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null
    let reportedAlpha: boolean | null = null
    let loggedError = false
    let lastRender = 0
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
        const now = performance.now()
        const s = state.current
        // Throttle: full-res readback is heavy, so render at ~25fps. Still
        // request the next frame each tick so we stay responsive to state
        // changes (size/framing/active) without a fixed-interval timer.
        if (s && s.active && ctx && device && now - lastRender >= RENDER_INTERVAL_MS) {
          lastRender = now
          // DISPLAY size (small thumbnail) vs RENDER size (near export res).
          const { pw, ph } = previewDims(s.outW, s.outH)
          const { rw, rh } = renderDims(s.outW, s.outH)
          try {
            if (!target || rw !== targetW || rh !== targetH) {
              target?.dispose()
              target = createExportRenderTarget(device, plan, rw, rh, images)
              targetW = rw
              targetH = rh
              offscreen = new OffscreenCanvas(rw, rh)
              // alpha: true keeps straight-alpha pixels intact through putImageData.
              offscreenCtx = offscreen.getContext('2d', {
                alpha: true,
              }) as OffscreenCanvasRenderingContext2D | null
            }
            if (cv && (cv.width !== pw || cv.height !== ph)) { cv.width = pw; cv.height = ph }
            // Real export framing: frameScale scaled by the render/export ratio so
            // a feature's size occupies the SAME FRACTION of the composition as it
            // will at full export. When rw == outW (small exports) the ratio is 1;
            // when capped below export size it is rw/outW (~0.78 at the 1600 cap
            // for a 2048 export) — still near 1, so `dither`/`pixelate` keep a
            // multi-pixel cell (this was the bug: the old code used the ~480px
            // DISPLAY width here, forcing the ratio to ~0.18 and a 1px cell). The
            // invariant preserved is feature-size-as-a-fraction-of-the-frame:
            // frameScale/renderPixels matches the export's frameScale/exportPixels,
            // which also keeps auto_uv (÷ u_frame_scale·u_ref_size) composition-
            // invariant. Density (dpr) passes through unscaled.
            const frameScale = s.framing.frameScale * (rw / Math.max(1, s.exportW))
            target.renderFrame({
              timeSec: (now - start) / 1000, // live wall-clock (preview only)
              frameScale,
              uDpr: s.framing.dpr,
              anchor: s.framing.anchor,
            })
            const px = await target.readback()
            if (disposed) return
            // Full-res straight-alpha → offscreen (replace), then high-quality
            // downscale into the small display canvas.
            if (offscreenCtx) {
              offscreenCtx.putImageData(new ImageData(px, rw, rh), 0, 0)
              ctx.clearRect(0, 0, pw, ph)
              ctx.imageSmoothingEnabled = true
              ctx.imageSmoothingQuality = 'high'
              if (offscreen) ctx.drawImage(offscreen, 0, 0, rw, rh, 0, 0, pw, ph)
            }
            // Detect translucency from the FULL-RES readback (alpha = every 4th
            // byte). Only scan until we've latched `true` (sticky).
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
