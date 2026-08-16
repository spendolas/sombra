/**
 * WebGPU fullscreen quad renderer — single-pass and multi-pass.
 *
 * Implements ShaderRenderer using the WebGPU API. Reads the `plan.wgsl.passes`
 * array from the RenderPlan produced by the IR compiler.
 *
 * Multi-pass: intermediate passes render to GPUTextures, which are sampled
 * by subsequent passes. The final pass renders to the canvas surface.
 *
 * Mirrors the WebGL2 renderer's animation loop, quality tiers, DPR capping,
 * and snap-to-static behavior.
 */

import { REFERENCE_SIZE as SHARED_REFERENCE_SIZE } from '../renderer/constants'
import type { RenderPlan } from '../compiler/glsl-generator'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import type { UniformBufferLayout, TextureBinding } from '../compiler/ir/wgsl-assembler'
import { passTargetSize, type PassTargetSize } from '../renderer/pass-size'
import { generateMipmaps, mipLevelCount } from './mipmaps'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PipelineCacheEntry {
  pipeline: GPURenderPipeline
  lastUsed: number
}

interface ImageTextureEntry {
  texture: GPUTexture
  sampler: GPUSampler
}

/** Per-pass GPU state for multi-pass rendering. */
interface PassState {
  pipeline: GPURenderPipeline
  uniformBuffer: GPUBuffer
  uniformData: ArrayBuffer
  uniformFloat32: Float32Array
  uniformLayout: UniformBufferLayout
  textureBindingsMeta: TextureBinding[]
  uniformBindGroup: GPUBindGroup | null
  textureBindGroup: GPUBindGroup | null
  inputTextures: Array<{ passIndex: number; samplerName: string }>
  isTimeLive: boolean
  textureFilter: 'linear' | 'nearest'
  /** Target scale for this pass. Undefined = full canvas resolution. */
  resolution?: number
}

/** Premultiplied source-over blend, baked into every canvas (final-pass)
 *  pipeline unconditionally. Over an opaque cleared background (checker/solid
 *  modes) it composites the premultiplied shader; over a transparent clear
 *  (see-through) it is mathematically identity (src.rgb·1 + 0·(1−a) = src.rgb),
 *  so see-through stays pixel-identical to a plain transparent canvas. Because
 *  the blend is constant, flipping background mode never rebuilds a pipeline —
 *  only the context alphaMode + the clear/checker change. */
const PREMULT_OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}
/** App surface colour (#0f0f1a) — opaque clear fallback. */
const SURFACE_RGB = { r: 0x0f / 255, g: 0x0f / 255, b: 0x1a / 255 }
/** Checker base colour (#2d2d44, surface-elevated) — cleared behind the drawn checker. */
const CHECKER_RGB = { r: 0x2d / 255, g: 0x2d / 255, b: 0x44 / 255 }

/** Procedural transparency checker, drawn opaque behind the shader in checker
 *  mode (the canvas is opaque then). Matches the DOM PreviewBackdrop exactly —
 *  surface-elevated #2d2d44 base + fg-muted #5a5a6e squares — and its 10 CSS-px
 *  tile: `squarePx` is 10·dpr device px, so the checker is dpr-invariant and
 *  identical to the CSS backdrop the WebGL2 fallback still paints. */
const CHECKER_WGSL = `
struct CheckerU { squarePx: f32, _pad0: f32, _pad1: f32, _pad2: f32 };
@group(0) @binding(0) var<uniform> cu: CheckerU;
@vertex fn vs_main(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return vec4f(pos, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let sq = max(cu.squarePx, 1.0);
  let cx = floor(fc.x / sq);
  let cy = floor(fc.y / sq);
  let s = (cx + cy) - 2.0 * floor((cx + cy) * 0.5);
  let base = vec3f(0.176, 0.176, 0.267);
  let alt  = vec3f(0.353, 0.353, 0.431);
  return vec4f(select(base, alt, s > 0.5), 1.0);
}`

/** Parse #rgb / #rrggbb / rgb()/rgba() to 0–1 RGB. Returns null on unknown format. */
function parseCssRgb(css: string): { r: number; g: number; b: number } | null {
  const s = css.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 }
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s)
  if (rgb) return { r: +rgb[1] / 255, g: +rgb[2] / 255, b: +rgb[3] / 255 }
  return null
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class WebGPUShaderRenderer implements ShaderRenderer {
  readonly backend = 'webgpu' as const

  private canvas!: HTMLCanvasElement
  private adapter!: GPUAdapter
  private device!: GPUDevice
  private context!: GPUCanvasContext
  private canvasFormat!: GPUTextureFormat

  /** Expose the GPUDevice for sharing with the preview renderer. */
  getDevice(): GPUDevice { return this.device }

  /** True on AMD GPUs, where a transparent (premultiplied) canvas composited
   *  over the page flickers under macOS/Chrome. The editor reads this to gate
   *  the see-through warning. */
  get isAmd(): boolean { return this.vendor === 'amd' }

  /** Expose uploaded image textures so the preview renderer can bind them too. */
  getImageTexture(samplerName: string): { texture: GPUTexture; sampler: GPUSampler } | null {
    return this.imageTextures.get(samplerName) ?? null
  }

  // Fullscreen quad
  private quadBuffer!: GPUBuffer

  // Single-pass state (kept for backward compat + simple path)
  private uniformBuffer: GPUBuffer | null = null
  private uniformData: ArrayBuffer | null = null
  private uniformFloat32: Float32Array | null = null
  private uniformLayout: UniformBufferLayout | null = null
  private pipeline: GPURenderPipeline | null = null
  private uniformBindGroup: GPUBindGroup | null = null
  private textureBindGroup: GPUBindGroup | null = null
  private textureBindingsMeta: TextureBinding[] = []

  // Multi-pass state
  private passStates: PassState[] = []
  private intermediateTextures: GPUTexture[] = []
  private intermediateSamplers: GPUSampler[] = []
  // Anchor point for coordinate origin (9-point grid, default center)
  private anchor: [number, number] = [0.5, 0.5]

  private isMultiPass = false
  /** Map uniform name → pass indices for routing uniform updates (multi-pass re-emission). */
  private uniformPassMap = new Map<string, number[]>()
  /**
   * Safety ceiling on intermediate textures (memory guard, not a GPU limit —
   * each is a full-canvas RGBA8 render target). Exceeding it fails the plan
   * loudly in updateMultiPass; the WebGL backend's FBO pool is uncapped.
   */
  private static readonly MAX_INTERMEDIATE_TEXTURES = 32
  /** Last allocated intermediate sizes, as a comparable key. */
  private lastIntermediateKey = ''

  // Pipeline cache — keyed by WGSL source hash
  private pipelineCache = new Map<string, PipelineCacheEntry>()
  private static readonly PIPELINE_CACHE_MAX = 32

  // Image textures
  private imageTextures = new Map<string, ImageTextureEntry>()

  // Animation
  private startTime: number = Date.now()
  private animationFrameId: number | null = null
  private animated = true
  private renderRequested = false
  private targetFps = 60
  private lastFrameTime = 0

  // Quality tier
  private currentTier: QualityTier = 'adaptive'
  private ANIMATED_DPR_SCALE = 0.75
  private STATIC_DPR_SCALE = 1.0
  private currentDprScale = 1.0
  private lastAnimationSpeed = 1.0

  // Background compositing (editor preview only). setBackgroundComposite() is
  // called with the current preview background mode:
  //   checker / solid → opaque canvas, background painted INTO the canvas, so
  //     the browser never does transparent compositing over the page (which
  //     flickers on AMD/Metal — see the preview-banding findings doc).
  //   see-through ('none') → transparent (premultiplied) canvas; the UI shows
  //     through. On AMD this flickers (informed + accepted; the editor shows a
  //     warning). Embeds/viewer never call this → they stay premultiplied.
  private opaqueBackground = false
  private compositeBg = SURFACE_RGB
  private compositeChecker = false
  private checkerPipeline: GPURenderPipeline | null = null
  private checkerUniformBuffer: GPUBuffer | null = null
  private checkerBindGroup: GPUBindGroup | null = null
  /** adapter.info.vendor, lowercased ('amd' | 'apple' | 'intel' | …). '' if unavailable. */
  private vendor = ''

  // Output alpha probe (editor-only). After a compile / settled uniform change,
  // the final pass is re-rendered to a tiny offscreen target with a TRANSPARENT
  // clear (PREMULT_OVER over transparent is identity, so it preserves the shader's
  // own alpha), read back, and the min alpha decides whether the master output has
  // any transparency. Reported via onOutputAlpha → compilerStore.outputHasAlpha.
  private static readonly ALPHA_PROBE_SIZE = 32
  private static readonly ALPHA_PROBE_BYTES_PER_ROW = 256 // align(32*4, 256)
  private static readonly ALPHA_PROBE_THROTTLE_MS = 250
  private probeTexture: GPUTexture | null = null
  private probeReadBuffer: GPUBuffer | null = null
  private needsAlphaProbe = false
  private probing = false
  private lastAlphaProbeAt = 0
  private outputAlphaCallback: ((hasAlpha: boolean) => void) | null = null

  /** Fixed reference size for DPR-independent UV scaling (shared constant). */
  private static readonly REFERENCE_SIZE = SHARED_REFERENCE_SIZE

  // Resize
  private resizeObserver: ResizeObserver | null = null

  // Device lost
  private deviceLostCallback: (() => void) | null = null

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  private configuredAlphaMode: GPUCanvasAlphaMode | null = null

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas

    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('WebGPU not supported — no adapter')
    this.adapter = adapter
    this.vendor = (adapter.info?.vendor ?? '').toLowerCase()

    this.device = await adapter.requestDevice()
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat()

    // Get the context but DON'T configure yet — defer to first render.
    // In React StrictMode, two renderers race to init on the same canvas.
    // The disposed one's configure() would overwrite the active one.
    // By deferring, only the renderer that actually renders will configure.
    this.context = canvas.getContext('webgpu') as GPUCanvasContext
    if (!this.context) throw new Error('Failed to get WebGPU canvas context')

    this.setupFullscreenQuad()
    this.setupDeviceLostHandler()

    this.resizeObserver = new ResizeObserver(() => {
      if (this.isMultiPass) this.resizeIntermediateTextures()
      this.requestRender()
    })
    this.resizeObserver.observe(canvas)
  }

  /** Configure (or reconfigure) the canvas context. alphaMode tracks the current
   *  background mode — opaque for checker/solid, premultiplied for see-through.
   *  Called every render; reconfigures only when the mode actually flips. */
  private ensureContextConfigured(): void {
    const want: GPUCanvasAlphaMode = this.opaqueBackground ? 'opaque' : 'premultiplied'
    if (this.configuredAlphaMode === want) return
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: want,
    })
    this.configuredAlphaMode = want
  }

  onDeviceLost(callback: () => void): void {
    this.deviceLostCallback = callback
  }

  onOutputAlpha(callback: (hasAlpha: boolean) => void): void {
    this.outputAlphaCallback = callback
  }

  dispose(): void {
    this.stopAnimation()
    this.resizeObserver?.disconnect()

    // Clean up GPU resources
    for (const entry of this.imageTextures.values()) {
      entry.texture.destroy()
    }
    this.imageTextures.clear()
    this.uniformBuffer?.destroy()
    this.uniformBuffer = null
    this.quadBuffer?.destroy()

    this.destroyMultiPassState()

    this.pipelineCache.clear()
    this.pipeline = null
    this.uniformBindGroup = null
    this.textureBindGroup = null
    this.probeTexture?.destroy()
    this.probeReadBuffer?.destroy()
    this.probeTexture = null
    this.probeReadBuffer = null

    // Release the GPUDevice itself — browsers cap devices per page, and
    // StrictMode double-init would otherwise leak one per mount cycle.
    // (The lost-handler ignores reason 'destroyed'. The shared preview
    // renderer is torn down alongside this in App.)
    this.device?.destroy()
  }

  // -----------------------------------------------------------------------
  // Init helpers
  // -----------------------------------------------------------------------

  private setupFullscreenQuad(): void {
    const vertices = new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ])
    this.quadBuffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    })
    new Float32Array(this.quadBuffer.getMappedRange()).set(vertices)
    this.quadBuffer.unmap()
  }

  private setupDeviceLostHandler(): void {
    this.device.lost.then((info: GPUDeviceLostInfo) => {
      console.warn('[Sombra WebGPU] Device lost:', info.reason, info.message)
      if (info.reason === 'destroyed') return

      this.stopAnimation()

      this.adapter.requestDevice().then((device: GPUDevice) => {
        this.device = device

        // Fresh device: force a reconfigure at the current mode's alphaMode.
        this.configuredAlphaMode = null
        this.ensureContextConfigured()

        this.setupFullscreenQuad()
        this.setupDeviceLostHandler()

        // Clear caches — old GPU objects are invalid
        this.pipelineCache.clear()
        this.pipeline = null
        this.checkerPipeline = null
        this.checkerUniformBuffer = null
        this.checkerBindGroup = null
        this.probeTexture = null       // belonged to the dead device
        this.probeReadBuffer = null
        this.needsAlphaProbe = true    // re-probe on the fresh device
        this.uniformBindGroup = null
        this.textureBindGroup = null
        this.uniformBuffer = null
        this.destroyMultiPassState()
        // Image textures belonged to the dead device — drop them so binds
        // don't reference invalid objects; the consumer re-uploads below.
        this.imageTextures.clear()

        if (this.animated) this.startAnimation()

        // Fire AFTER recovery: the consumer re-applies the render plan and
        // re-uploads image textures onto the fresh device.
        this.deviceLostCallback?.()
      }).catch((err: unknown) => {
        console.error('[Sombra WebGPU] Failed to recover from device loss:', err)
      })
    })
  }

  // -----------------------------------------------------------------------
  // Shader / pipeline
  // -----------------------------------------------------------------------

  updateRenderPlan(plan: RenderPlan): { success: boolean; error?: string } {
    if (!plan.success || plan.passes.length === 0) {
      return { success: false, error: 'Invalid render plan' }
    }

    if (!plan.wgsl || !plan.wgsl.passes || plan.wgsl.passes.length === 0) {
      return { success: false, error: 'No WGSL data in render plan (IR unavailable)' }
    }

    const wgslPasses = plan.wgsl.passes

    let result: { success: boolean; error?: string }
    if (wgslPasses.length === 1) {
      // Single-pass fast path
      this.destroyMultiPassState()
      this.isMultiPass = false
      result = this.updateSinglePass(wgslPasses[0])
    } else {
      result = this.updateMultiPass(wgslPasses)
    }
    // A new plan can change the output's transparency — re-probe on next render.
    if (result.success) this.needsAlphaProbe = true
    return result
  }

  private updateSinglePass(wgslPass: NonNullable<RenderPlan['wgsl']>['passes'][number]): { success: boolean; error?: string } {
    const { shaderCode, uniformLayout, textureBindings } = wgslPass

    this.uniformLayout = uniformLayout
    this.textureBindingsMeta = textureBindings
    this.createUniformBuffer(uniformLayout.totalSize)

    const cacheKey = simpleHash(shaderCode)
    const cached = this.pipelineCache.get(cacheKey)
    if (cached) {
      cached.lastUsed = Date.now()
      this.pipeline = cached.pipeline
      this.rebuildBindGroups()
      return { success: true }
    }

    const shaderModule = this.device.createShaderModule({ code: shaderCode })
    this.logCompilationErrors(shaderModule)

    try {
      const pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: shaderModule,
          entryPoint: 'vs_main',
          buffers: [VERTEX_BUFFER_LAYOUT],
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'fs_main',
          targets: [{ format: this.canvasFormat, blend: PREMULT_OVER }],
        },
        primitive: { topology: 'triangle-list' },
      })

      this.pipeline = pipeline
      this.pipelineCache.set(cacheKey, { pipeline, lastUsed: Date.now() })
      this.evictPipelineCache()
      this.rebuildBindGroups()

      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[Sombra WebGPU] Pipeline creation failed:', msg)
      return { success: false, error: msg }
    }
  }

  private updateMultiPass(wgslPasses: NonNullable<RenderPlan['wgsl']>['passes']): { success: boolean; error?: string } {
    // Fail loudly instead of silently breaking: past this point every frame
    // would thrash the texture pool and the final canvas pass would never run.
    const numIntermediate = wgslPasses.length - 1
    if (numIntermediate > WebGPUShaderRenderer.MAX_INTERMEDIATE_TEXTURES) {
      return {
        success: false,
        error: `Graph needs ${numIntermediate} intermediate render targets (max ${WebGPUShaderRenderer.MAX_INTERMEDIATE_TEXTURES}) — reduce effect chain depth`,
      }
    }

    this.destroyMultiPassState()
    this.isMultiPass = true
    this.pipeline = null  // Clear single-pass pipeline

    const passStates: PassState[] = []
    const uniformPassMap = new Map<string, number[]>()

    for (let i = 0; i < wgslPasses.length; i++) {
      const wp = wgslPasses[i]
      const isLastPass = i === wgslPasses.length - 1

      // Create shader module
      const shaderModule = this.device.createShaderModule({ code: wp.shaderCode })
      this.logCompilationErrors(shaderModule)

      // Create pipeline — intermediate passes render to canvas format too
      // (intermediate textures use the same format for simplicity)
      let pipeline: GPURenderPipeline
      try {
        pipeline = this.device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [VERTEX_BUFFER_LAYOUT],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{ format: isLastPass ? this.canvasFormat : 'rgba8unorm', blend: isLastPass ? PREMULT_OVER : undefined }],
          },
          primitive: { topology: 'triangle-list' },
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[Sombra WebGPU] Pipeline creation failed for pass ${i}:`, msg)
        // Clean up already-created pass states
        for (const ps of passStates) ps.uniformBuffer.destroy()
        return { success: false, error: msg }
      }

      // Create uniform buffer for this pass
      const bufSize = wp.uniformLayout.totalSize
      const uniformBuffer = this.device.createBuffer({
        size: bufSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      const uniformData = new ArrayBuffer(bufSize)
      const uniformFloat32 = new Float32Array(uniformData)

      // Map uniform names to this pass index (uniforms may appear in multiple passes due to re-emission)
      for (const name of wp.uniformLayout.offsets.keys()) {
        const existing = uniformPassMap.get(name)
        if (existing) existing.push(i)
        else uniformPassMap.set(name, [i])
      }

      passStates.push({
        pipeline,
        uniformBuffer,
        uniformData,
        uniformFloat32,
        uniformLayout: wp.uniformLayout,
        textureBindingsMeta: wp.textureBindings,
        uniformBindGroup: null,
        textureBindGroup: null,
        inputTextures: wp.inputTextures,
        isTimeLive: wp.isTimeLive,
        textureFilter: wp.textureFilter ?? 'linear',
        resolution: wp.resolution,
      })
    }

    this.passStates = passStates
    this.uniformPassMap = uniformPassMap

    // Build bind groups (intermediate textures will be created on first render)
    this.rebuildMultiPassBindGroups()

    return { success: true }
  }

  private destroyMultiPassState(): void {
    for (const ps of this.passStates) {
      ps.uniformBuffer.destroy()
    }
    this.passStates = []
    for (const tex of this.intermediateTextures) {
      tex.destroy()
    }
    this.intermediateTextures = []
    this.intermediateSamplers = []
    this.uniformPassMap.clear()
    this.lastIntermediateKey = ''
  }

  /**
   * Target size and matching u_dpr for every pass, honouring
   * RenderPass.resolution. `w`/`h` are the full render size in device px.
   */
  private passTargetSizes(w: number, h: number): PassTargetSize[] {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const maxTex = this.device.limits.maxTextureDimension2D
    return this.passStates.map((ps) => passTargetSize(ps.resolution, w, h, dpr, maxTex))
  }

  /** Pool identity: sizes, not one width/height pair. */
  private passSizeKey(sizes: PassTargetSize[]): string {
    return sizes.map((s) => `${s.width}x${s.height}`).join(',')
  }

  /** Ensure intermediate textures exist and match each pass's target size. */
  private ensureIntermediateTextures(width: number, height: number): void {
    const numIntermediate = this.passStates.length - 1
    if (numIntermediate <= 0) return

    // Compare against the ALLOCATED count: comparing against the uncapped
    // pass count made this mismatch permanently for over-cap graphs — the
    // pool was destroyed and recreated every single frame.
    const cap = Math.min(numIntermediate, WebGPUShaderRenderer.MAX_INTERMEDIATE_TEXTURES)
    const sizes = this.passTargetSizes(width, height).slice(0, cap)
    const key = this.passSizeKey(sizes)
    if (this.intermediateTextures.length === cap && this.lastIntermediateKey === key) {
      return
    }

    // Destroy old
    for (const tex of this.intermediateTextures) tex.destroy()
    this.intermediateTextures = []
    this.intermediateSamplers = []

    for (let i = 0; i < cap; i++) {
      const texture = this.device.createTexture({
        size: [sizes[i].width, sizes[i].height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.intermediateTextures.push(texture)

      // Sampler with per-pass filter hint
      const filterMode = this.passStates[i].textureFilter === 'nearest' ? 'nearest' : 'linear'
      const sampler = this.device.createSampler({
        minFilter: filterMode as GPUFilterMode,
        magFilter: filterMode as GPUFilterMode,
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })
      this.intermediateSamplers.push(sampler)
    }

    this.lastIntermediateKey = key

    // Rebuild bind groups since texture views changed
    this.rebuildMultiPassBindGroups()
  }

  /**
   * Resize intermediate textures to match current canvas pixel size.
   * Called from ResizeObserver, applyTier, and notifyChange (mirrors WebGL resizeFBOs).
   */
  private resizeIntermediateTextures(): void {
    if (this.passStates.length <= 1) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const w = Math.floor(this.canvas.clientWidth * dpr) || 1
    const h = Math.floor(this.canvas.clientHeight * dpr) || 1
    this.ensureIntermediateTextures(w, h)
  }

  private rebuildMultiPassBindGroups(): void {
    for (let i = 0; i < this.passStates.length; i++) {
      const ps = this.passStates[i]

      // Group 0: uniform buffer
      ps.uniformBindGroup = this.device.createBindGroup({
        layout: ps.pipeline.getBindGroupLayout(0),
        entries: [{
          binding: 0,
          resource: { buffer: ps.uniformBuffer },
        }],
      })

      // Group 1: textures (inter-pass + image)
      ps.textureBindGroup = this.buildPassTextureBindGroup(i, ps)
    }
  }

  private buildPassTextureBindGroup(_passIndex: number, ps: PassState): GPUBindGroup | null {
    if (ps.textureBindingsMeta.length === 0) return null

    const entries: GPUBindGroupEntry[] = []

    for (const binding of ps.textureBindingsMeta) {
      // Check if this is an inter-pass texture
      const passInput = ps.inputTextures.find(it => it.samplerName === binding.samplerName)
      if (passInput) {
        const srcTexIdx = passInput.passIndex
        if (srcTexIdx < this.intermediateTextures.length) {
          entries.push({
            binding: binding.textureBinding,
            resource: this.intermediateTextures[srcTexIdx].createView(),
          })
          entries.push({
            binding: binding.samplerBinding,
            resource: this.intermediateSamplers[srcTexIdx],
          })
        } else {
          return null // Intermediate texture not yet allocated
        }
      } else {
        // Image texture
        const imgEntry = this.imageTextures.get(binding.samplerName)
        if (!imgEntry) return null // Image not uploaded yet
        entries.push({
          binding: binding.textureBinding,
          resource: imgEntry.texture.createView(),
        })
        entries.push({
          binding: binding.samplerBinding,
          resource: imgEntry.sampler,
        })
      }
    }

    if (entries.length === 0) return null

    try {
      return this.device.createBindGroup({
        layout: ps.pipeline.getBindGroupLayout(1),
        entries,
      })
    } catch {
      return null
    }
  }

  // Single-pass helpers

  private createUniformBuffer(size: number): void {
    if (this.uniformBuffer && this.uniformData && this.uniformData.byteLength === size) {
      return
    }
    this.uniformBuffer?.destroy()

    this.uniformBuffer = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.uniformData = new ArrayBuffer(size)
    this.uniformFloat32 = new Float32Array(this.uniformData)
  }

  private rebuildBindGroups(): void {
    if (!this.pipeline || !this.uniformBuffer) return

    this.uniformBindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: { buffer: this.uniformBuffer },
      }],
    })

    this.rebuildTextureBindGroup()
  }

  private rebuildTextureBindGroup(): void {
    if (!this.pipeline || this.textureBindingsMeta.length === 0) {
      this.textureBindGroup = null
      return
    }

    const entries: GPUBindGroupEntry[] = []
    let hasAllTextures = true

    for (const binding of this.textureBindingsMeta) {
      const imgEntry = this.imageTextures.get(binding.samplerName)
      if (!imgEntry) {
        hasAllTextures = false
        break
      }
      entries.push({
        binding: binding.textureBinding,
        resource: imgEntry.texture.createView(),
      })
      entries.push({
        binding: binding.samplerBinding,
        resource: imgEntry.sampler,
      })
    }

    if (!hasAllTextures || entries.length === 0) {
      this.textureBindGroup = null
      return
    }

    try {
      this.textureBindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(1),
        entries,
      })
    } catch {
      this.textureBindGroup = null
    }
  }

  private logCompilationErrors(module: GPUShaderModule): void {
    module.getCompilationInfo().then((info) => {
      for (const msg of info.messages) {
        if (msg.type === 'error') {
          console.error(`[Sombra WebGPU] WGSL compile error (line ${msg.lineNum}): ${msg.message}`)
        } else if (msg.type === 'warning') {
          console.warn(`[Sombra WebGPU] WGSL warning (line ${msg.lineNum}): ${msg.message}`)
        }
      }
    })
  }

  private evictPipelineCache(): void {
    if (this.pipelineCache.size <= WebGPUShaderRenderer.PIPELINE_CACHE_MAX) return

    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, entry] of this.pipelineCache) {
      if (entry.lastUsed < oldestTime && entry.pipeline !== this.pipeline) {
        oldestKey = key
        oldestTime = entry.lastUsed
      }
    }
    if (oldestKey) {
      this.pipelineCache.delete(oldestKey)
    }
  }

  // -----------------------------------------------------------------------
  // Uniforms
  // -----------------------------------------------------------------------

  updateUniforms(uniforms: Array<{ name: string; value: number | number[] }>): void {
    if (this.isMultiPass) {
      this.updateMultiPassUniforms(uniforms)
    } else {
      this.updateSinglePassUniforms(uniforms)
    }
    // A param can drive alpha (e.g. an opacity slider), so re-probe — throttled in
    // maybeProbeAlpha so a drag doesn't cause a readback storm.
    this.needsAlphaProbe = true
    this.requestRender()
  }

  private updateSinglePassUniforms(uniforms: Array<{ name: string; value: number | number[] }>): void {
    if (!this.uniformLayout || !this.uniformFloat32 || !this.uniformBuffer) return

    for (const { name, value } of uniforms) {
      const offset: number | undefined = this.uniformLayout.offsets.get(name)
      if (offset === undefined) continue

      const floatOffset = offset / 4
      if (typeof value === 'number') {
        this.uniformFloat32[floatOffset] = value
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          this.uniformFloat32[floatOffset + i] = value[i]
        }
      }
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData!)
  }

  private updateMultiPassUniforms(uniforms: Array<{ name: string; value: number | number[] }>): void {
    const dirtyPasses = new Set<number>()

    for (const { name, value } of uniforms) {
      const passIndices = this.uniformPassMap.get(name)
      if (!passIndices) continue

      for (const passIdx of passIndices) {
        const ps = this.passStates[passIdx]
        const offset = ps.uniformLayout.offsets.get(name)
        if (offset === undefined) continue

        const floatOffset = offset / 4
        if (typeof value === 'number') {
          ps.uniformFloat32[floatOffset] = value
        } else if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            ps.uniformFloat32[floatOffset + i] = value[i]
          }
        }
        dirtyPasses.add(passIdx)
      }
    }

    for (const passIdx of dirtyPasses) {
      const ps = this.passStates[passIdx]
      this.device.queue.writeBuffer(ps.uniformBuffer, 0, ps.uniformData)
    }
  }

  private writeSinglePassBuiltinUniforms(w: number, h: number, dpr: number, time: number): void {
    if (!this.uniformLayout || !this.uniformFloat32 || !this.uniformBuffer) return

    const set = (name: string, ...values: number[]) => {
      const offset = this.uniformLayout!.offsets.get(name)
      if (offset === undefined) return
      const base = offset / 4
      for (let i = 0; i < values.length; i++) {
        this.uniformFloat32![base + i] = values[i]
      }
    }

    set('u_time', time)
    set('u_resolution', w, h)
    set('u_dpr', dpr)
    set('u_ref_size', WebGPUShaderRenderer.REFERENCE_SIZE)
    set('u_viewport', w, h)
    set('u_anchor', this.anchor[0], this.anchor[1])

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData!)
  }

  private writeMultiPassBuiltinUniforms(w: number, h: number, dpr: number, time: number): void {
    const sizes = this.passTargetSizes(w, h)
    for (let i = 0; i < this.passStates.length; i++) {
      const ps = this.passStates[i]
      const set = (name: string, ...values: number[]) => {
        const offset = ps.uniformLayout.offsets.get(name)
        if (offset === undefined) return
        const base = offset / 4
        for (let j = 0; j < values.length; j++) {
          ps.uniformFloat32[base + j] = values[j]
        }
      }

      // The LAST pass draws to the swap-chain texture, which is always full
      // canvas size regardless of what it declared.
      const isLast = i === this.passStates.length - 1
      const tw = isLast ? w : (sizes[i]?.width ?? w)
      const th = isLast ? h : (sizes[i]?.height ?? h)
      const tdpr = isLast ? dpr : (sizes[i]?.dpr ?? dpr)

      set('u_time', time)
      set('u_resolution', tw, th)
      set('u_dpr', tdpr)
      set('u_ref_size', WebGPUShaderRenderer.REFERENCE_SIZE)
      set('u_viewport', tw, th)
      set('u_anchor', this.anchor[0], this.anchor[1])

      this.device.queue.writeBuffer(ps.uniformBuffer, 0, ps.uniformData)
    }
  }

  // -----------------------------------------------------------------------
  // Image textures
  // -----------------------------------------------------------------------

  uploadImageTexture(samplerName: string, image: HTMLImageElement): void {
    const existing = this.imageTextures.get(samplerName)
    if (existing) {
      existing.texture.destroy()
    }

    const iw = image.naturalWidth || image.width
    const ih = image.naturalHeight || image.height
    const levels = mipLevelCount(iw, ih)
    const texture = this.device.createTexture({
      size: [iw, ih],
      mipLevelCount: levels,
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST |
             GPUTextureUsage.RENDER_ATTACHMENT,
    })

    createImageBitmap(image, { imageOrientation: 'flipY' }).then((bitmap) => {
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height],
      )
      // Fill the mip chain so minification (small canvas, or pixelate/reeded) is clean.
      generateMipmaps(this.device, texture, levels)

      const sampler = this.device.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })

      this.imageTextures.set(samplerName, { texture, sampler })

      if (this.isMultiPass) {
        this.rebuildMultiPassBindGroups()
      } else {
        this.rebuildTextureBindGroup()
      }
      this.requestRender()
    }).catch((err) => {
      console.error('[Sombra WebGPU] Image upload failed:', err)
    })
  }

  deleteImageTexture(samplerName: string): void {
    const entry = this.imageTextures.get(samplerName)
    if (entry) {
      entry.texture.destroy()
      this.imageTextures.delete(samplerName)
      if (this.isMultiPass) {
        this.rebuildMultiPassBindGroups()
      } else {
        this.rebuildTextureBindGroup()
      }
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  render(): void {
    this.ensureContextConfigured()

    // Update canvas size
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const displayWidth = Math.floor(this.canvas.clientWidth * dpr)
    const displayHeight = Math.floor(this.canvas.clientHeight * dpr)
    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth
      this.canvas.height = displayHeight
    }

    const time = (Date.now() - this.startTime) / 1000

    if (this.isMultiPass) {
      this.renderMultiPass(displayWidth, displayHeight, dpr, time)
    } else {
      this.renderSinglePass(displayWidth, displayHeight, dpr, time)
    }

    // After the real frame, probe the output's alpha if pending (throttled).
    this.maybeProbeAlpha(time)
  }

  private renderSinglePass(w: number, h: number, dpr: number, time: number): void {
    if (!this.pipeline || !this.uniformBindGroup) return

    this.writeSinglePassBuiltinUniforms(w, h, dpr, time)

    const currentTexture = this.context.getCurrentTexture()
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: currentTexture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: this.opaqueBackground ? { ...this.compositeBg, a: 1 } : { r: 0, g: 0, b: 0, a: 0 },
      }],
    })

    if (this.opaqueBackground && this.compositeChecker) this.drawChecker(pass, dpr)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.uniformBindGroup)
    if (this.textureBindGroup) {
      pass.setBindGroup(1, this.textureBindGroup)
    }
    pass.setVertexBuffer(0, this.quadBuffer)
    pass.draw(6)
    pass.end()

    this.device.queue.submit([encoder.finish()])
  }

  private renderMultiPass(w: number, h: number, dpr: number, time: number): void {
    if (this.passStates.length === 0) return

    // Ensure intermediate textures are allocated and correctly sized
    this.ensureIntermediateTextures(w, h)

    // Write built-in uniforms to all passes
    this.writeMultiPassBuiltinUniforms(w, h, dpr, time)

    const encoder = this.device.createCommandEncoder()

    for (let i = 0; i < this.passStates.length; i++) {
      const ps = this.passStates[i]
      const isLastPass = i === this.passStates.length - 1

      // Determine render target
      let targetView: GPUTextureView
      if (isLastPass) {
        targetView = this.context.getCurrentTexture().createView()
      } else {
        if (i >= this.intermediateTextures.length) break
        targetView = this.intermediateTextures[i].createView()
      }

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: targetView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: (isLastPass && this.opaqueBackground) ? { ...this.compositeBg, a: 1 } : { r: 0, g: 0, b: 0, a: 0 },
        }],
      })

      if (isLastPass && this.opaqueBackground && this.compositeChecker) this.drawChecker(pass, dpr)
      pass.setPipeline(ps.pipeline)
      pass.setBindGroup(0, ps.uniformBindGroup!)
      if (ps.textureBindGroup) {
        pass.setBindGroup(1, ps.textureBindGroup)
      }
      pass.setVertexBuffer(0, this.quadBuffer)
      pass.draw(6)
      pass.end()
    }

    this.device.queue.submit([encoder.finish()])
  }

  clear(): void {
    if (!this.device) return
    this.ensureContextConfigured()

    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    })
    pass.end()
    this.device.queue.submit([encoder.finish()])
    this.setAnimated(false)
  }

  // -----------------------------------------------------------------------
  // Animation / quality tier
  // -----------------------------------------------------------------------

  setAnimated(animated: boolean): void {
    if (this.animated === animated) return
    this.animated = animated
    if (animated) {
      this.currentDprScale = this.ANIMATED_DPR_SCALE
      this.startAnimation()
    } else {
      this.stopAnimation()
      this.currentDprScale = this.STATIC_DPR_SCALE
      this.requestRender()
    }
  }

  setAnimationSpeed(speed: number): void {
    this.lastAnimationSpeed = speed
    if (this.currentTier !== 'adaptive') return
    if (speed < 0.05) this.targetFps = 30
    else if (speed < 0.15) this.targetFps = 45
    else this.targetFps = 60
  }

  setQualityTier(tier: QualityTier): void {
    if (this.currentTier === tier) return
    this.currentTier = tier
    this.applyTier()
  }

  setAnchor(anchor: [number, number]): void {
    this.anchor = anchor
    this.requestRender()
  }

  /** Editor-only: set the preview background mode. checker/solid make the canvas
   *  opaque and paint the background into it (no transparent compositing over the
   *  page → no AMD flicker); see-through ('none') keeps the canvas transparent so
   *  the UI shows through. The alphaMode flip is applied on the next render.
   *  Embeds/viewer never call this and stay transparent (premultiplied). */
  setBackgroundComposite(bg: { mode: 'checker' | 'solid' | 'none'; color: string } | null): void {
    if (!bg) return
    this.opaqueBackground = bg.mode !== 'none'
    this.compositeChecker = bg.mode === 'checker'
    if (bg.mode === 'solid') this.compositeBg = parseCssRgb(bg.color) ?? SURFACE_RGB
    else if (bg.mode === 'checker') this.compositeBg = CHECKER_RGB
    else this.compositeBg = SURFACE_RGB
    // Apply the alphaMode flip now rather than waiting for the next render — the
    // reconfigure is deterministic and avoids a one-frame frame at the wrong
    // alphaMode. Safe: only the live renderer receives this call (the disposed
    // StrictMode twin is never wired up), and the context exists post-init.
    if (this.context) this.ensureContextConfigured()
    this.requestRender()
  }

  /** Draw the opaque transparency checker (checker mode) behind the shader. The
   *  square size is 10·dpr device px, so the tile matches the CSS PreviewBackdrop
   *  on every display. Nulled resources rebuild lazily after device loss. */
  private drawChecker(pass: GPURenderPassEncoder, dpr: number): void {
    const pipeline = this.ensureCheckerPipeline()
    this.device.queue.writeBuffer(this.checkerUniformBuffer!, 0, new Float32Array([10 * dpr, 0, 0, 0]))
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, this.checkerBindGroup!)
    pass.setVertexBuffer(0, this.quadBuffer)
    pass.draw(6)
  }

  /** Lazily build the checker-fill pipeline (opaque, no blend) plus its
   *  squarePx uniform + bind group. Nulled on device loss so it rebuilds. */
  private ensureCheckerPipeline(): GPURenderPipeline {
    if (!this.checkerPipeline) {
      const module = this.device.createShaderModule({ code: CHECKER_WGSL })
      this.checkerPipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main', buffers: [VERTEX_BUFFER_LAYOUT] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: this.canvasFormat }] },
        primitive: { topology: 'triangle-list' },
      })
      this.checkerUniformBuffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.checkerBindGroup = this.device.createBindGroup({
        layout: this.checkerPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.checkerUniformBuffer } }],
      })
    }
    return this.checkerPipeline
  }

  // -----------------------------------------------------------------------
  // Output alpha probe
  // -----------------------------------------------------------------------

  /** Run a pending alpha probe (throttled) after a real frame. Fire-and-forget:
   *  the readback resolves async and calls back with the result. */
  private maybeProbeAlpha(time: number): void {
    if (!this.needsAlphaProbe || this.probing || !this.outputAlphaCallback) return
    const ready = this.isMultiPass ? this.passStates.length > 0 : !!this.pipeline
    if (!ready) return
    const now = Date.now()
    if (now - this.lastAlphaProbeAt < WebGPUShaderRenderer.ALPHA_PROBE_THROTTLE_MS) return

    this.needsAlphaProbe = false
    this.lastAlphaProbeAt = now
    this.probing = true
    this.probeOutputAlpha(time)
      .then((hasAlpha) => { this.outputAlphaCallback?.(hasAlpha) })
      .catch(() => { /* device lost / mapping failed — leave last value */ })
      .finally(() => { this.probing = false })
  }

  private ensureProbeResources(size: number): void {
    if (!this.probeTexture) {
      this.probeTexture = this.device.createTexture({
        size: [size, size],
        format: this.canvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      })
    }
    if (!this.probeReadBuffer) {
      this.probeReadBuffer = this.device.createBuffer({
        size: WebGPUShaderRenderer.ALPHA_PROBE_BYTES_PER_ROW * size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
    }
  }

  /**
   * Re-render the final pass to a tiny offscreen target with a transparent clear
   * and read back the minimum alpha. Reuses the live pipeline + bind groups; only
   * the built-in uniforms are rewritten to the probe resolution (so auto_uv spans
   * the whole frame) — params stay as-is. The shared uniform buffer is written per
   * submit in queue order, so the concurrent main frames stay correct.
   * Returns true if any sampled pixel has alpha < ~1.
   */
  private async probeOutputAlpha(time: number): Promise<boolean> {
    const SIZE = WebGPUShaderRenderer.ALPHA_PROBE_SIZE
    const bytesPerRow = WebGPUShaderRenderer.ALPHA_PROBE_BYTES_PER_ROW
    this.ensureProbeResources(SIZE)
    const tex = this.probeTexture
    const buf = this.probeReadBuffer
    if (!tex || !buf) return true

    let pipeline: GPURenderPipeline | null
    let uniformBindGroup: GPUBindGroup | null
    let textureBindGroup: GPUBindGroup | null
    if (this.isMultiPass) {
      this.writeMultiPassBuiltinUniforms(SIZE, SIZE, 1, time)
      const last = this.passStates[this.passStates.length - 1]
      pipeline = last?.pipeline ?? null
      uniformBindGroup = last?.uniformBindGroup ?? null
      textureBindGroup = last?.textureBindGroup ?? null
    } else {
      this.writeSinglePassBuiltinUniforms(SIZE, SIZE, 1, time)
      pipeline = this.pipeline
      uniformBindGroup = this.uniformBindGroup
      textureBindGroup = this.textureBindGroup
    }
    if (!pipeline || !uniformBindGroup) return true // can't probe → assume alpha (safe)

    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: tex.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, uniformBindGroup)
    if (textureBindGroup) pass.setBindGroup(1, textureBindGroup)
    pass.setVertexBuffer(0, this.quadBuffer)
    pass.draw(6)
    pass.end()
    encoder.copyTextureToBuffer(
      { texture: tex },
      { buffer: buf, bytesPerRow, rowsPerImage: SIZE },
      { width: SIZE, height: SIZE },
    )
    this.device.queue.submit([encoder.finish()])

    await buf.mapAsync(GPUMapMode.READ)
    let minAlpha = 255
    try {
      const data = new Uint8Array(buf.getMappedRange())
      for (let row = 0; row < SIZE; row++) {
        const base = row * bytesPerRow
        for (let col = 0; col < SIZE; col++) {
          const a = data[base + col * 4 + 3]
          if (a < minAlpha) minAlpha = a
        }
      }
    } finally {
      buf.unmap()
    }
    return minAlpha < 250 // < ~0.98 ⇒ output carries transparency
  }

  private applyTier(): void {
    switch (this.currentTier) {
      case 'adaptive':
        this.ANIMATED_DPR_SCALE = 0.75
        this.STATIC_DPR_SCALE = 1.0
        this.setAnimationSpeed(this.lastAnimationSpeed)
        break
      case 'low':
        this.ANIMATED_DPR_SCALE = 0.5
        this.STATIC_DPR_SCALE = 0.5
        this.targetFps = 30
        break
      case 'medium':
        this.ANIMATED_DPR_SCALE = 0.75
        this.STATIC_DPR_SCALE = 0.75
        this.targetFps = 45
        break
      case 'high':
        this.ANIMATED_DPR_SCALE = 1.0
        this.STATIC_DPR_SCALE = 1.0
        this.targetFps = 60
        break
    }
    this.currentDprScale = this.animated ? this.ANIMATED_DPR_SCALE : this.STATIC_DPR_SCALE
    if (this.isMultiPass) this.resizeIntermediateTextures()
    this.requestRender()
  }

  notifyChange(): void {
    if (!this.animated) return
    // Defensive only: while animating, the animated scale is what should be in
    // force. Nothing should be able to leave it at STATIC now, but restoring it
    // here is free and the resize is covered downstream.
    if (this.currentDprScale !== this.ANIMATED_DPR_SCALE) {
      this.currentDprScale = this.ANIMATED_DPR_SCALE
    }
    // There used to be a 2s "snap to static DPR" here: it raised the scale,
    // resized the intermediates, rendered ONE crisp frame, then reverted and
    // resized again WITHOUT re-rendering. Because it only ran while `animated` was
    // true, the animation loop overwrote that frame immediately — so it could never
    // deliver a crisp frame, and it could not be repaired by dropping the revert
    // either (that just leaves the scale raised while animating). All it actually
    // did was one wasted full-resolution multi-pass render plus two full
    // destroy/recreate cycles of the intermediate pool every 2 seconds, and an
    // intermittent one-frame flash when the loop skipped the following rAF.
    // Crispness on settle is already handled: setAnimated(false) restores
    // STATIC_DPR_SCALE and re-renders.
  }

  requestRender(): void {
    if (this.animated || this.renderRequested) return
    this.renderRequested = true
    requestAnimationFrame(() => {
      this.renderRequested = false
      this.render()
    })
  }

  markAllDirty(): void {
    // For multi-pass: forces re-render of all passes on next frame.
    // Since we currently render all passes every frame anyway, this is a no-op.
    // When dirty propagation is added, this will set all pass dirty flags.
    this.requestRender()
  }

  // -----------------------------------------------------------------------
  // Animation loop
  // -----------------------------------------------------------------------

  startAnimation(): void {
    this.lastFrameTime = performance.now()
    const animate = (timestamp: number) => {
      const elapsed = timestamp - this.lastFrameTime
      const interval = 1000 / this.targetFps
      if (elapsed >= interval) {
        this.lastFrameTime = timestamp - (elapsed % interval)
        this.render()
      }
      this.animationFrameId = requestAnimationFrame(animate)
    }
    this.animationFrameId = requestAnimationFrame(animate)
  }

  stopAnimation(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 8,
  attributes: [{
    shaderLocation: 0,
    offset: 0,
    format: 'float32x2',
  }],
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Simple string hash for pipeline cache keys. */
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return hash.toString(36)
}
