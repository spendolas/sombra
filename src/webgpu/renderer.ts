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

import type { RenderPlan } from '../compiler/glsl-generator'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import type { UniformBufferLayout, TextureBinding } from '../compiler/ir/wgsl-assembler'

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
  private isMultiPass = false
  /** Map uniform name → pass indices for routing uniform updates (multi-pass re-emission). */
  private uniformPassMap = new Map<string, number[]>()
  /** Max intermediate textures (desktop). */
  private static readonly MAX_INTERMEDIATE_TEXTURES = 8
  /** Last rendered intermediate texture dimensions. */
  private lastIntermediateWidth = 0
  private lastIntermediateHeight = 0

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
  private snapTimer: ReturnType<typeof setTimeout> | null = null
  private lastAnimationSpeed = 1.0

  /** Fixed reference size for DPR-independent UV scaling. */
  private static readonly REFERENCE_SIZE = 512

  // Resize
  private resizeObserver: ResizeObserver | null = null

  // Device lost
  private deviceLostCallback: (() => void) | null = null

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  private contextConfigured = false

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas

    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('WebGPU not supported — no adapter')
    this.adapter = adapter

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

  /** Configure the canvas context on first use. */
  private ensureContextConfigured(): void {
    if (this.contextConfigured) return
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: 'premultiplied',
    })
    this.contextConfigured = true
  }

  onDeviceLost(callback: () => void): void {
    this.deviceLostCallback = callback
  }

  dispose(): void {
    this.stopAnimation()
    if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null }
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
      this.deviceLostCallback?.()

      this.adapter.requestDevice().then((device: GPUDevice) => {
        this.device = device

        this.context.configure({
          device: this.device,
          format: this.canvasFormat,
          alphaMode: 'premultiplied',
        })

        this.setupFullscreenQuad()
        this.setupDeviceLostHandler()

        // Clear caches — old GPU objects are invalid
        this.pipelineCache.clear()
        this.pipeline = null
        this.uniformBindGroup = null
        this.textureBindGroup = null
        this.uniformBuffer = null
        this.destroyMultiPassState()

        if (this.animated) this.startAnimation()
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

    if (wgslPasses.length === 1) {
      // Single-pass fast path
      this.destroyMultiPassState()
      this.isMultiPass = false
      return this.updateSinglePass(wgslPasses[0])
    }

    // Multi-pass
    return this.updateMultiPass(wgslPasses)
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
          targets: [{ format: this.canvasFormat }],
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
            targets: [{ format: isLastPass ? this.canvasFormat : 'rgba8unorm' }],
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
    this.lastIntermediateWidth = 0
    this.lastIntermediateHeight = 0
  }

  /** Ensure intermediate textures exist and match the current render size. */
  private ensureIntermediateTextures(width: number, height: number): void {
    const numIntermediate = this.passStates.length - 1
    if (numIntermediate <= 0) return

    // Check if resize needed
    if (this.intermediateTextures.length === numIntermediate &&
        this.lastIntermediateWidth === width &&
        this.lastIntermediateHeight === height) {
      return
    }

    // Destroy old
    for (const tex of this.intermediateTextures) tex.destroy()
    this.intermediateTextures = []
    this.intermediateSamplers = []

    const cap = Math.min(numIntermediate, WebGPUShaderRenderer.MAX_INTERMEDIATE_TEXTURES)

    for (let i = 0; i < cap; i++) {
      const texture = this.device.createTexture({
        size: [width, height],
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

    this.lastIntermediateWidth = width
    this.lastIntermediateHeight = height

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

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData!)
  }

  private writeMultiPassBuiltinUniforms(w: number, h: number, dpr: number, time: number): void {
    for (const ps of this.passStates) {
      const set = (name: string, ...values: number[]) => {
        const offset = ps.uniformLayout.offsets.get(name)
        if (offset === undefined) return
        const base = offset / 4
        for (let i = 0; i < values.length; i++) {
          ps.uniformFloat32[base + i] = values[i]
        }
      }

      set('u_time', time)
      set('u_resolution', w, h)
      set('u_dpr', dpr)
      set('u_ref_size', WebGPUShaderRenderer.REFERENCE_SIZE)
      set('u_viewport', w, h)

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

    const texture = this.device.createTexture({
      size: [image.naturalWidth || image.width, image.naturalHeight || image.height],
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

      const sampler = this.device.createSampler({
        minFilter: 'linear',
        magFilter: 'linear',
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
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    })

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
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      })

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
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
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
      if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null }
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
    if (this.currentDprScale !== this.ANIMATED_DPR_SCALE) {
      this.currentDprScale = this.ANIMATED_DPR_SCALE
    }
    if (this.snapTimer) clearTimeout(this.snapTimer)
    this.snapTimer = setTimeout(() => {
      if (this.animated) {
        this.currentDprScale = this.STATIC_DPR_SCALE
        if (this.isMultiPass) this.resizeIntermediateTextures()
        this.render()
        this.currentDprScale = this.ANIMATED_DPR_SCALE
        if (this.isMultiPass) this.resizeIntermediateTextures()
      }
    }, 2000)
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
