/**
 * Factory functions for creating renderer instances.
 *
 * Tries WebGPU first, falls back to WebGL2.
 */

import type { ShaderRenderer, PreviewRenderer } from './types'

/**
 * Create and initialize a main shader renderer on the given canvas.
 * Tries WebGPU first. Falls back to WebGL2 on failure or when WebGPU is unavailable.
 */
export async function createShaderRenderer(
  canvas: HTMLCanvasElement,
): Promise<ShaderRenderer> {
  if (typeof navigator !== 'undefined' && navigator.gpu) {
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
 * Returns a PreviewRenderer backed by WebGL2 (future: WebGPU when available).
 */
export async function createPreviewRenderer(): Promise<PreviewRenderer> {
  // Preview renderer uses WebGL2 (async GPU readback for WebGPU previews is a future task)
  const { WebGL2PreviewRenderer } = await import('../webgl/preview-renderer')
  const renderer = new WebGL2PreviewRenderer()
  await renderer.init()
  return renderer
}
