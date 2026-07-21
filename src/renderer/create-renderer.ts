/**
 * Factory functions for creating renderer instances.
 *
 * Tries WebGPU first, falls back to WebGL2.
 */

import type { ShaderRenderer, PreviewRenderer, RenderPlan } from './types'

/**
 * Create and initialize a main shader renderer on the given canvas.
 * Tries WebGPU first. Falls back to WebGL2 on failure or when WebGPU is unavailable.
 */
/** `?backend=webgl2` forces the WebGL2 fallback — the only way to exercise it in a WebGPU-capable browser. */
export function isWebGL2Forced(): boolean {
  return typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('backend') === 'webgl2'
}

export async function createShaderRenderer(
  canvas: HTMLCanvasElement,
  plan?: RenderPlan,
): Promise<ShaderRenderer> {
  // A plan with no WGSL passes (e.g. an embed artifact published from a
  // non-WebGPU browser) can't run on WebGPU — force WebGL2, which renders the
  // GLSL passes. Omitting `plan` (app/viewer, which compile fresh) keeps
  // WebGPU-first behavior unchanged.
  const planRunsOnWebGPU = !plan || !!plan.wgsl?.passes?.length
  if (typeof navigator !== 'undefined' && navigator.gpu && !isWebGL2Forced() && planRunsOnWebGPU) {
    try {
      const { WebGPUShaderRenderer } = await import('../webgpu/renderer')
      const renderer = new WebGPUShaderRenderer()
      await renderer.init(canvas)
      console.log('[Sombra] Renderer backend:', renderer.backend)
      return renderer
    } catch (e) {
      console.warn('[Sombra] WebGPU init failed, falling back to WebGL2:', e)
    }
  }

  const { WebGL2ShaderRenderer } = await import('../webgl/renderer')
  const renderer = new WebGL2ShaderRenderer()
  await renderer.init(canvas)
  console.log('[Sombra] Renderer backend:', renderer.backend)
  return renderer
}

/**
 * Create and initialize an offscreen preview renderer for node thumbnails.
 * When the main renderer is WebGPU, shares its GPUDevice for preview rendering.
 * Falls back to WebGL2 otherwise.
 */
export async function createPreviewRenderer(
  mainRenderer?: ShaderRenderer,
): Promise<PreviewRenderer> {
  if (mainRenderer?.backend === 'webgpu') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const device = (mainRenderer as any).getDevice() as GPUDevice
      const { WebGPUPreviewRenderer } = await import('../webgpu/preview-renderer')
      const renderer = new WebGPUPreviewRenderer(device)
      // Image-node textures live on the main renderer; previews bind the same
      // GPUTexture objects (shared device) instead of re-uploading.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderer.setImageTextureProvider((name) => (mainRenderer as any).getImageTexture(name))
      await renderer.init()
      console.log('[Sombra] Preview renderer backend: webgpu (shared device)')
      return renderer
    } catch (e) {
      console.warn('[Sombra] WebGPU preview init failed, falling back to WebGL2:', e)
    }
  }

  const { WebGL2PreviewRenderer } = await import('../webgl/preview-renderer')
  const renderer = new WebGL2PreviewRenderer()
  await renderer.init()
  console.log('[Sombra] Preview renderer backend: webgl2')
  return renderer
}
