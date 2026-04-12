/**
 * Offscreen WebGPU renderer for per-node preview thumbnails.
 *
 * Uses the shared GPUDevice from the main renderer. Renders to an 80×80
 * GPUTexture, copies to a staging buffer, and reads back as ImageBitmap.
 *
 * Supports single-pass and multi-pass previews via ping-pong textures.
 */

import type { PreviewRenderer as IPreviewRenderer, UniformUpload } from '../renderer/types'
import type { UniformBufferLayout, TextureBinding } from '../compiler/ir/wgsl-assembler'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREVIEW_SIZE = 80
const BYTES_PER_ROW = Math.ceil(PREVIEW_SIZE * 4 / 256) * 256  // 512
const STAGING_SIZE = BYTES_PER_ROW * PREVIEW_SIZE               // 40960

/** Frozen reference size — must match the main renderer's REFERENCE_SIZE. */
const REFERENCE_SIZE = 512

const MAX_PIPELINE_CACHE = 64

// ---------------------------------------------------------------------------
// WGSL preview pass data (richer than PreviewPassSource)
// ---------------------------------------------------------------------------

export interface WGSLPreviewPass {
  shaderCode: string
  uniformLayout: UniformBufferLayout
  textureBindings: TextureBinding[]
  inputTextures: Array<{ passIndex: number; samplerName: string }>
  userUniforms: UniformUpload[]
}

// ---------------------------------------------------------------------------
// Vertex shader (same fullscreen quad as main renderer)
// ---------------------------------------------------------------------------

const VERTEX_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_uv: vec2f,
}

@vertex
fn vs_main(@location(0) a_position: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.v_uv = a_position * 0.5 + 0.5;
  out.position = vec4f(a_position, 0.0, 1.0);
  return out;
}
`

const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 8,
  attributes: [{
    shaderLocation: 0,
    offset: 0,
    format: 'float32x2',
  }],
}

// ---------------------------------------------------------------------------
// Pipeline cache entry
// ---------------------------------------------------------------------------

interface PipelineCacheEntry {
  pipeline: GPURenderPipeline
  lastUsed: number
}

// ---------------------------------------------------------------------------
// Per-pass GPU state for multi-pass preview
// ---------------------------------------------------------------------------

interface PreviewPassState {
  pipeline: GPURenderPipeline
  uniformBuffer: GPUBuffer
  uniformData: ArrayBuffer
  uniformFloat32: Float32Array
  uniformLayout: UniformBufferLayout
  textureBindingsMeta: TextureBinding[]
  uniformBindGroup: GPUBindGroup
  textureBindGroup: GPUBindGroup | null
  inputTextures: Array<{ passIndex: number; samplerName: string }>
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class WebGPUPreviewRenderer implements IPreviewRenderer {
  readonly backend = 'webgpu' as const

  private device: GPUDevice
  private quadBuffer!: GPUBuffer
  private vertexShaderModule!: GPUShaderModule
  private renderTexture!: GPUTexture
  private stagingBuffer!: GPUBuffer
  private pipelineCache = new Map<string, PipelineCacheEntry>()
  private cacheOrder: string[] = []
  private startTime = Date.now()

  // Ping-pong textures for multi-pass (lazy init)
  private pingPongTextures: GPUTexture[] | null = null
  private pingPongSamplers: GPUSampler[] | null = null

  // Render lock — only one render can use the staging buffer at a time.
  // Each render awaits this promise before starting, then replaces it.
  private renderLock: Promise<void> = Promise.resolve()

  constructor(device: GPUDevice) {
    this.device = device
  }

  async init(): Promise<void> {
    // Fullscreen quad vertex buffer
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

    // Shared vertex shader module
    this.vertexShaderModule = this.device.createShaderModule({ code: VERTEX_SHADER })

    // Render target texture (80×80)
    this.renderTexture = this.device.createTexture({
      size: [PREVIEW_SIZE, PREVIEW_SIZE],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })

    // Staging buffer for CPU readback
    this.stagingBuffer = this.device.createBuffer({
      size: STAGING_SIZE,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
  }

  /**
   * No-op for WebGPU — preview uses fixed PREVIEW_SIZE and REFERENCE_SIZE.
   */
  setMainResolution(): void {
    // No-op — preview uses fixed PREVIEW_SIZE and REFERENCE_SIZE
  }

  // -----------------------------------------------------------------------
  // GLSL-compatible interface (for backward compat — scheduler delegates)
  // -----------------------------------------------------------------------

  /**
   * Render a single-pass preview from GLSL fragment shader.
   * This path is NOT used when the scheduler knows we're WebGPU —
   * it calls renderWGSLPreview() directly. Kept for interface compliance.
   */
  async renderPreview(): Promise<ImageBitmap | null> {
    // WebGPU preview renderer only supports WGSL path via renderWGSLPreview()
    console.warn('[WebGPU preview] renderPreview() called with GLSL — use renderWGSLPreview()')
    return null
  }

  /**
   * Multi-pass GLSL preview — not supported, use renderWGSLPreview().
   */
  async renderMultiPassPreview(): Promise<ImageBitmap | null> {
    console.warn('[WebGPU preview] renderMultiPassPreview() called with GLSL — use renderWGSLPreview()')
    return null
  }

  // -----------------------------------------------------------------------
  // WGSL preview path (called by scheduler when backend is 'webgpu')
  // -----------------------------------------------------------------------

  /**
   * Render a WGSL preview (single or multi-pass) and return an ImageBitmap.
   */
  async renderWGSLPreview(passes: WGSLPreviewPass[]): Promise<ImageBitmap | null> {
    if (passes.length === 0) return null

    // Serialize renders — only one can use the staging buffer at a time
    const prevLock = this.renderLock
    let unlock: () => void
    this.renderLock = new Promise(resolve => { unlock = resolve })

    try {
      await prevLock
      if (passes.length === 1) {
        return await this.renderSinglePassWGSL(passes[0])
      }
      return await this.renderMultiPassWGSL(passes)
    } catch (e) {
      console.warn('[WebGPU preview] render error:', e instanceof Error ? e.message : e)
      return null
    } finally {
      unlock!()
    }
  }

  // -----------------------------------------------------------------------
  // Single-pass WGSL render
  // -----------------------------------------------------------------------

  private async renderSinglePassWGSL(pass: WGSLPreviewPass): Promise<ImageBitmap | null> {
    const pipeline = await this.getOrCreatePipeline(pass.shaderCode)
    if (!pipeline) return null

    // Create uniform buffer and write values
    const uniformBuffer = this.createPassUniformBuffer(pass.uniformLayout)
    const uniformFloat32 = new Float32Array(new ArrayBuffer(pass.uniformLayout.totalSize))
    this.writeBuiltinUniforms(uniformFloat32, pass.uniformLayout)
    this.writeUserUniforms(uniformFloat32, pass.uniformLayout, pass.userUniforms)
    this.device.queue.writeBuffer(uniformBuffer, 0, uniformFloat32.buffer)

    // Create bind groups
    const uniformBindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })

    // Render
    const encoder = this.device.createCommandEncoder()
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.renderTexture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    })

    renderPass.setPipeline(pipeline)
    renderPass.setBindGroup(0, uniformBindGroup)
    renderPass.setVertexBuffer(0, this.quadBuffer)
    renderPass.draw(6)
    renderPass.end()

    // Readback
    const bitmap = await this.readbackTexture(encoder)

    // Cleanup per-render uniform buffer
    uniformBuffer.destroy()

    return bitmap
  }

  // -----------------------------------------------------------------------
  // Multi-pass WGSL render
  // -----------------------------------------------------------------------

  private async renderMultiPassWGSL(passes: WGSLPreviewPass[]): Promise<ImageBitmap | null> {
    this.ensurePingPongTextures()

    const time = (Date.now() - this.startTime) / 1000
    const passStates: PreviewPassState[] = []

    // Build pass states
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i]
      const pipeline = await this.getOrCreatePipeline(pass.shaderCode)
      if (!pipeline) {
        // Cleanup already-created buffers
        for (const ps of passStates) ps.uniformBuffer.destroy()
        return null
      }

      const uniformBuffer = this.createPassUniformBuffer(pass.uniformLayout)
      const uniformData = new ArrayBuffer(pass.uniformLayout.totalSize)
      const uniformFloat32 = new Float32Array(uniformData)
      this.writeBuiltinUniforms(uniformFloat32, pass.uniformLayout, time)
      this.writeUserUniforms(uniformFloat32, pass.uniformLayout, pass.userUniforms)
      this.device.queue.writeBuffer(uniformBuffer, 0, uniformData)

      const uniformBindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      })

      // Build texture bind group for inter-pass textures
      let textureBindGroup: GPUBindGroup | null = null
      if (pass.textureBindings.length > 0 && this.pingPongTextures) {
        const entries: GPUBindGroupEntry[] = []
        for (const binding of pass.textureBindings) {
          const passInput = pass.inputTextures.find(it => it.samplerName === binding.samplerName)
          if (passInput && passInput.passIndex < this.pingPongTextures.length) {
            entries.push({
              binding: binding.textureBinding,
              resource: this.pingPongTextures[passInput.passIndex % 2].createView(),
            })
            entries.push({
              binding: binding.samplerBinding,
              resource: this.pingPongSamplers![passInput.passIndex % 2],
            })
          }
        }
        if (entries.length > 0) {
          try {
            textureBindGroup = this.device.createBindGroup({
              layout: pipeline.getBindGroupLayout(1),
              entries,
            })
          } catch {
            textureBindGroup = null
          }
        }
      }

      passStates.push({
        pipeline,
        uniformBuffer,
        uniformData,
        uniformFloat32,
        uniformLayout: pass.uniformLayout,
        textureBindingsMeta: pass.textureBindings,
        uniformBindGroup,
        textureBindGroup,
        inputTextures: pass.inputTextures,
      })
    }

    // Render all passes
    const encoder = this.device.createCommandEncoder()

    for (let i = 0; i < passStates.length; i++) {
      const ps = passStates[i]
      const isLastPass = i === passStates.length - 1

      // Determine render target
      let targetView: GPUTextureView
      if (isLastPass) {
        targetView = this.renderTexture.createView()
      } else {
        targetView = this.pingPongTextures![i % 2].createView()
      }

      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: targetView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      })

      renderPass.setPipeline(ps.pipeline)
      renderPass.setBindGroup(0, ps.uniformBindGroup)
      if (ps.textureBindGroup) {
        renderPass.setBindGroup(1, ps.textureBindGroup)
      }
      renderPass.setVertexBuffer(0, this.quadBuffer)
      renderPass.draw(6)
      renderPass.end()
    }

    // Readback from the render texture (last pass wrote here)
    const bitmap = await this.readbackTexture(encoder)

    // Cleanup per-render uniform buffers
    for (const ps of passStates) ps.uniformBuffer.destroy()

    return bitmap
  }

  // -----------------------------------------------------------------------
  // Uniform helpers
  // -----------------------------------------------------------------------

  private createPassUniformBuffer(layout: UniformBufferLayout): GPUBuffer {
    return this.device.createBuffer({
      size: layout.totalSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  private writeBuiltinUniforms(
    float32: Float32Array,
    layout: UniformBufferLayout,
    time?: number,
  ): void {
    const t = time ?? (Date.now() - this.startTime) / 1000

    const set = (name: string, ...values: number[]) => {
      const offset = layout.offsets.get(name)
      if (offset === undefined) return
      const base = offset / 4
      for (let i = 0; i < values.length; i++) {
        float32[base + i] = values[i]
      }
    }

    set('u_time', t)
    set('u_resolution', PREVIEW_SIZE, PREVIEW_SIZE)
    set('u_ref_size', REFERENCE_SIZE)
    set('u_dpr', 1.0)
    set('u_viewport', PREVIEW_SIZE, PREVIEW_SIZE)
    set('u_mouse', 0, 0)
  }

  private writeUserUniforms(
    float32: Float32Array,
    layout: UniformBufferLayout,
    uniforms: UniformUpload[],
  ): void {
    for (const u of uniforms) {
      const offset = layout.offsets.get(u.name)
      if (offset === undefined) continue
      const base = offset / 4
      if (typeof u.value === 'number') {
        float32[base] = u.value
      } else if (Array.isArray(u.value)) {
        for (let i = 0; i < u.value.length; i++) {
          float32[base + i] = u.value[i]
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Texture readback
  // -----------------------------------------------------------------------

  private async readbackTexture(encoder: GPUCommandEncoder): Promise<ImageBitmap | null> {
    encoder.copyTextureToBuffer(
      { texture: this.renderTexture },
      { buffer: this.stagingBuffer, bytesPerRow: BYTES_PER_ROW },
      [PREVIEW_SIZE, PREVIEW_SIZE],
    )

    this.device.queue.submit([encoder.finish()])

    await this.stagingBuffer.mapAsync(GPUMapMode.READ)
    const mapped = new Uint8Array(this.stagingBuffer.getMappedRange())

    // Strip row padding: copy PREVIEW_SIZE*4 bytes from each BYTES_PER_ROW-byte row
    // WebGPU Y=0 is top → no flip needed (unlike WebGL2)
    const pixels = new Uint8ClampedArray(PREVIEW_SIZE * PREVIEW_SIZE * 4)
    for (let y = 0; y < PREVIEW_SIZE; y++) {
      pixels.set(
        mapped.subarray(y * BYTES_PER_ROW, y * BYTES_PER_ROW + PREVIEW_SIZE * 4),
        y * PREVIEW_SIZE * 4,
      )
    }

    this.stagingBuffer.unmap()

    const imageData = new ImageData(pixels, PREVIEW_SIZE, PREVIEW_SIZE)
    return createImageBitmap(imageData)
  }

  // -----------------------------------------------------------------------
  // Pipeline cache
  // -----------------------------------------------------------------------

  private async getOrCreatePipeline(shaderCode: string): Promise<GPURenderPipeline | null> {
    const cached = this.pipelineCache.get(shaderCode)
    if (cached) {
      cached.lastUsed = Date.now()
      // Move to end of LRU
      const idx = this.cacheOrder.indexOf(shaderCode)
      if (idx !== -1) {
        this.cacheOrder.splice(idx, 1)
        this.cacheOrder.push(shaderCode)
      }
      return cached.pipeline
    }

    // Compile pipeline
    try {
      const fragmentModule = this.device.createShaderModule({ code: shaderCode })

      const pipeline = await this.device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: {
          module: this.vertexShaderModule,
          entryPoint: 'vs_main',
          buffers: [VERTEX_BUFFER_LAYOUT],
        },
        fragment: {
          module: fragmentModule,
          entryPoint: 'fs_main',
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list' },
      })

      // LRU eviction
      if (this.cacheOrder.length >= MAX_PIPELINE_CACHE) {
        const evict = this.cacheOrder.shift()!
        this.pipelineCache.delete(evict)
      }

      this.pipelineCache.set(shaderCode, { pipeline, lastUsed: Date.now() })
      this.cacheOrder.push(shaderCode)
      return pipeline
    } catch (e) {
      console.warn('[WebGPU preview] pipeline compile error:', e instanceof Error ? e.message : e)
      return null
    }
  }

  // -----------------------------------------------------------------------
  // Ping-pong textures for multi-pass
  // -----------------------------------------------------------------------

  private ensurePingPongTextures(): void {
    if (this.pingPongTextures) return

    this.pingPongTextures = [0, 1].map(() =>
      this.device.createTexture({
        size: [PREVIEW_SIZE, PREVIEW_SIZE],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      })
    )

    this.pingPongSamplers = [0, 1].map(() =>
      this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })
    )
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  dispose(): void {
    this.pipelineCache.clear()
    this.cacheOrder = []
    this.renderTexture?.destroy()
    this.stagingBuffer?.destroy()
    this.quadBuffer?.destroy()
    if (this.pingPongTextures) {
      for (const tex of this.pingPongTextures) tex.destroy()
      this.pingPongTextures = null
      this.pingPongSamplers = null
    }
  }
}
