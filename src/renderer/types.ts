/**
 * Renderer abstraction interfaces for the WebGPU migration.
 *
 * Both ShaderRenderer (main canvas) and PreviewRenderer (offscreen thumbnails)
 * are implemented by backend-specific classes (WebGL2, future WebGPU).
 * Consumers interact with these interfaces only — never with gl.* directly.
 */

import type { RenderPlan } from '../compiler/glsl-generator'
import type { UniformUpload } from '../webgl/preview-renderer'

// Re-export for convenience — consumers import from here
export type { RenderPlan, UniformUpload }

/**
 * Quality tier controlling DPR scaling and FPS caps.
 * Moved here from src/webgl/renderer.ts so it's backend-agnostic.
 */
export type QualityTier = 'adaptive' | 'low' | 'medium' | 'high'

// ---------------------------------------------------------------------------
// Main renderer interface (DOM canvas, multi-pass, animation loop)
// ---------------------------------------------------------------------------

export interface ShaderRenderer {
  /** Initialize the renderer on a canvas element. Async for WebGPU adapter/device. */
  init(canvas: HTMLCanvasElement): Promise<void>

  /** Release all GPU resources. */
  dispose(): void

  /** Register a callback for GPU device/context loss. */
  onDeviceLost(callback: () => void): void

  /** Apply a compiled render plan (from the compiler output). */
  updateRenderPlan(plan: RenderPlan): { success: boolean; error?: string }

  /** Upload uniform values (fast path — no recompile). */
  updateUniforms(uniforms: Array<{ name: string; value: number | number[] }>): void

  /** Upload (or replace) an image texture for a sampler uniform. */
  uploadImageTexture(samplerName: string, image: HTMLImageElement): void

  /** Delete an image texture by sampler name. */
  deleteImageTexture(samplerName: string): void

  /** Render a frame. Computes time/resolution/DPR internally. */
  render(): void

  /** Clear canvas to black (used on compile failure). */
  clear(): void

  /** Toggle continuous animation mode. */
  setAnimated(animated: boolean): void

  /** Hint animation speed for adaptive FPS (adaptive tier only). */
  setAnimationSpeed(speed: number): void

  /** Set the quality/performance tier. */
  setQualityTier(tier: QualityTier): void

  /** Notify of a change (triggers snap-to-static DPR for quality snapshot). */
  notifyChange(): void

  /** Request a single render frame (for static/non-animated graphs). */
  requestRender(): void

  /** Start the continuous animation loop. */
  startAnimation(): void

  /** Stop the continuous animation loop. */
  stopAnimation(): void

  /** Mark all multi-pass render passes as dirty. */
  markAllDirty(): void

  /** Which backend is active. */
  readonly backend: 'webgl2' | 'webgpu'
}

// ---------------------------------------------------------------------------
// Preview renderer interface (offscreen, async readback)
// ---------------------------------------------------------------------------

/** Pass data for multi-pass preview rendering. */
export interface PreviewPassSource {
  fragmentShader: string
  uniforms: UniformUpload[]
  inputTextures: Record<string, number>
}

export interface PreviewRenderer {
  /** Initialize the offscreen renderer. Async for WebGPU device. */
  init(): Promise<void>

  /** Release all GPU resources. */
  dispose(): void

  /**
   * Render a single-pass preview and return the thumbnail.
   * Returns Promise for WebGPU async readback; WebGL2 wraps sync result.
   */
  renderPreview(
    fragmentShader: string,
    uniforms: UniformUpload[],
  ): Promise<ImageBitmap | null>

  /**
   * Render a multi-pass preview chain and return the thumbnail.
   * Returns Promise for WebGPU async readback; WebGL2 wraps sync result.
   */
  renderMultiPassPreview(
    passes: PreviewPassSource[],
  ): Promise<ImageBitmap | null>

  /** Forward main canvas resolution for pixel-based uniform calculations. */
  setMainResolution(width: number, height: number): void

  /** Which backend is active. */
  readonly backend: 'webgl2' | 'webgpu'
}
