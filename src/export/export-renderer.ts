/**
 * Offscreen WebGPU export renderer.
 *
 * Generalises `WebGPUPreviewRenderer`'s offscreen render + `copyTextureToBuffer`
 * readback (fixed 80×80) to an ARBITRARY target size, driven by EXPLICIT uniform
 * values (time / resolution / dpr / anchor) instead of an internal `Date.now()`
 * clock. This is what lets a deterministic engine (Task 4) render frame `i` at
 * `u_time = i / fps` and read back reproducible pixels.
 *
 * Editor-side code — NOT the shipped embed bundle — so importing from
 * `src/webgpu/*` / `src/renderer/*` and type-only from `src/compiler/*` is fine.
 *
 * v1 is WebGPU-only for export. The structure below is deliberately a standalone
 * copy of the preview/main renderers' render loop (they are NOT shared): sharing
 * is its own future commit, and premature sharing has bitten this repo before.
 *
 * Alpha: the offscreen target is premultiplied (the shaders write premultiplied
 * RGB, exactly as the main canvas — `alphaMode: 'premultiplied'` — consumes).
 * `readback()` and `toVideoFrame()` un-premultiply back to STRAIGHT alpha, which
 * is what the WebCodecs sinks and PNG frames expect.
 */

import type { RenderPlan } from '../compiler/glsl-generator'
import type { UniformBufferLayout, TextureBinding } from '../compiler/ir/wgsl-assembler'
import { REFERENCE_SIZE } from '../renderer/constants'
import { passTargetSize } from '../renderer/pass-size'
import { generateMipmaps, mipLevelCount } from '../webgpu/mipmaps'

// ---------------------------------------------------------------------------
// Public interface (consumed verbatim by Task 4)
// ---------------------------------------------------------------------------

export interface ExportFrameUniforms {
  /** Deterministic frame time in seconds (e.g. `i / fps`). Drives `u_time`. */
  timeSec: number
  /** Framing scale (Task 6). Drives `u_dpr` on the final pass. */
  uDpr: number
  /** Fragment Output anchor, default [0.5, 0.5]. Drives `u_anchor`. */
  anchor: [number, number]
}

export interface ExportRenderTarget {
  readonly device: GPUDevice
  readonly width: number
  readonly height: number
  /**
   * Render one frame to the offscreen texture. Writes built-in uniforms from
   * `frame` into each pass's uniform buffer using `pass.uniformLayout.offsets`
   * (dynamic — never a hardcoded offset table). Fire-and-forget: the GPU work
   * is submitted synchronously; results become readable via `readback()`.
   */
  renderFrame(frame: ExportFrameUniforms): void
  /** Read back the offscreen texture as STRAIGHT-alpha RGBA8 (un-premultiplied). */
  readback(): Promise<Uint8ClampedArray> // length width*height*4, row-major, Y-down
  /**
   * A `VideoFrame` for the WebCodecs sinks — straight alpha, at `timestampUs`.
   * Reuses the pixels from the most recent `readback()` (call `readback()` for
   * the same frame first). GPU→CPU copy is async, so this synchronous method
   * cannot itself read the texture.
   */
  toVideoFrame(timestampUs: number): VideoFrame
  dispose(): void
}

export function createExportRenderTarget(
  device: GPUDevice,
  plan: RenderPlan,
  width: number,
  height: number,
  /** samplerName → decoded image (via `decodeGraphImages`). Absent → dummy fallback. */
  images?: Map<string, ImageBitmap>,
): ExportRenderTarget {
  return new ExportRenderTargetImpl(device, plan, width, height, images)
}

// ---------------------------------------------------------------------------
// Vertex shader plumbing
//
// The IR-assembled `shaderCode` already contains BOTH `@vertex fn vs_main` and
// `@fragment fn fs_main` (see wgsl-assembler.ts:343), taking `a_position: vec2f`
// at @location(0) — so, like the MAIN renderer, we use the one module for both
// stages rather than a separate vertex module (the preview renderer's approach).
// ---------------------------------------------------------------------------

const VERTEX_BUFFER_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 8,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
}

// ---------------------------------------------------------------------------
// Per-pass GPU state
// ---------------------------------------------------------------------------

interface ExportPassState {
  pipeline: GPURenderPipeline
  uniformBuffer: GPUBuffer
  /** Persistent CPU-side mirror. User uniforms written once; built-ins per frame. */
  uniformData: ArrayBuffer
  uniformFloat32: Float32Array
  uniformLayout: UniformBufferLayout
  uniformBindGroup: GPUBindGroup
  /** group(1): inter-pass + image textures. null when the pass samples nothing. */
  textureBindGroup: GPUBindGroup | null
  /** Mirrors RenderPass.resolution — the pass's target scale. */
  resolution?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class ExportRenderTargetImpl implements ExportRenderTarget {
  readonly device: GPUDevice
  readonly width: number
  readonly height: number

  private readonly bytesPerRow: number
  private readonly quadBuffer: GPUBuffer
  private readonly renderTexture: GPUTexture
  private readonly stagingBuffer: GPUBuffer

  private readonly passStates: ExportPassState[] = []
  private readonly intermediateTextures: GPUTexture[] = []
  private readonly intermediateSamplers: GPUSampler[] = []

  /** samplerName → uploaded image texture (decoded on this device from the graph). */
  private readonly imageTextures = new Map<string, { texture: GPUTexture; sampler: GPUSampler }>()

  /** 1×1 transparent fallback for image samplers whose image is missing/undecodable. */
  private dummyTexture: GPUTexture | null = null
  private dummySampler: GPUSampler | null = null

  /** Last straight-alpha readback, reused by `toVideoFrame`. */
  private lastPixels: Uint8ClampedArray | null = null
  /**
   * Monotonic tag for the current offscreen-texture contents, bumped once per
   * `renderFrame`. `toVideoFrame` compares it against the generation the last
   * `readback` actually copied — so reusing stale pixels (a `renderFrame` with
   * no matching `readback`) throws loudly instead of silently emitting the
   * previous frame's bytes.
   */
  private renderGeneration = 0
  /** Generation whose pixels `lastPixels` holds. -1 = no readback yet. */
  private lastReadbackGeneration = -1
  /** Reused canvas for `toVideoFrame` → VideoFrame. */
  private videoCanvas: OffscreenCanvas | null = null
  private videoCtx: OffscreenCanvasRenderingContext2D | null = null

  /** Serialise readbacks — concurrent mapAsync on one staging buffer throws. */
  private readbackLock: Promise<void> = Promise.resolve()

  private disposed = false

  constructor(
    device: GPUDevice,
    plan: RenderPlan,
    width: number,
    height: number,
    images?: Map<string, ImageBitmap>,
  ) {
    const wgslPasses = plan.wgsl?.passes
    if (!wgslPasses || wgslPasses.length === 0) {
      throw new Error('[export] RenderPlan has no WGSL passes (IR path unavailable)')
    }
    if (width <= 0 || height <= 0) {
      throw new Error(`[export] invalid target size ${width}×${height}`)
    }

    this.device = device
    this.width = width
    this.height = height

    // 256-aligned bytesPerRow, exactly like preview-renderer, but at `width`.
    this.bytesPerRow = Math.ceil((width * 4) / 256) * 256
    const stagingSize = this.bytesPerRow * height

    // Fullscreen quad (two triangles).
    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1])
    this.quadBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    })
    new Float32Array(this.quadBuffer.getMappedRange()).set(vertices)
    this.quadBuffer.unmap()

    // Offscreen render target (final pass) + readback staging buffer.
    this.renderTexture = device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    })
    this.stagingBuffer = device.createBuffer({
      size: stagingSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    // User uniform VALUES are carried by the GLSL RenderPass list (their WGSL
    // twin has only the layout). Gather name → value across every pass; a name
    // shared by re-emitted nodes carries the same value, so a flat map is safe.
    // Mirrors the preview scheduler's `deserializeWGSLPasses`.
    const userUniformValues = new Map<string, number | number[]>()
    for (const p of plan.passes) {
      for (const u of p.userUniforms) userUniformValues.set(u.name, u.value)
    }

    // Intermediate textures: one per NON-final pass. Their pixel size depends
    // only on `resolution` and the target size — NOT on u_dpr (passTargetSize
    // scales only the returned `dpr` by baseDpr, never width/height) — so they
    // are allocated once here. A base dpr of 1 is passed purely because the
    // signature requires one; the width/height it returns are dpr-independent.
    const maxTex = device.limits.maxTextureDimension2D
    const numIntermediate = wgslPasses.length - 1
    for (let i = 0; i < numIntermediate; i++) {
      const size = passTargetSize(wgslPasses[i].resolution, width, height, 1, maxTex)
      this.intermediateTextures.push(
        device.createTexture({
          size: [size.width, size.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }),
      )
      const filter: GPUFilterMode =
        wgslPasses[i].textureFilter === 'nearest' ? 'nearest' : 'linear'
      this.intermediateSamplers.push(
        device.createSampler({
          magFilter: filter,
          minFilter: filter,
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        }),
      )
    }

    // Upload the graph's images to this device (same flip/format/sampler as the
    // main renderer's uploadImageTexture) so image samplers bind real textures.
    if (images) {
      for (const [samplerName, bitmap] of images) {
        const levels = mipLevelCount(bitmap.width, bitmap.height)
        const texture = device.createTexture({
          size: [bitmap.width, bitmap.height],
          mipLevelCount: levels,
          format: 'rgba8unorm',
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        })
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
          bitmap.width,
          bitmap.height,
        ])
        // Mip chain so minification through the pass chain stays clean.
        generateMipmaps(device, texture, levels)
        const sampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        })
        this.imageTextures.set(samplerName, { texture, sampler })
      }
    }

    // Build every pass's pipeline, uniform buffer, and bind groups once.
    for (let i = 0; i < wgslPasses.length; i++) {
      const wp = wgslPasses[i]
      const module = device.createShaderModule({ code: wp.shaderCode })
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main', buffers: [VERTEX_BUFFER_LAYOUT] },
        // All passes (final AND intermediate) target rgba8unorm — the offscreen
        // texture is never a canvas surface, so there is no canvasFormat here.
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })

      const uniformData = new ArrayBuffer(wp.uniformLayout.totalSize)
      const uniformFloat32 = new Float32Array(uniformData)
      // User uniforms are static for the whole export (params are baked at
      // compile time; animation is driven by u_time). Write them once, filtered
      // to names present in THIS pass's layout.
      writeUserUniforms(uniformFloat32, wp.uniformLayout, userUniformValues)

      const uniformBuffer = device.createBuffer({
        size: wp.uniformLayout.totalSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      const uniformBindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      })

      const textureBindGroup = this.buildTextureBindGroup(pipeline, wp.textureBindings, wp.inputTextures)

      this.passStates.push({
        pipeline,
        uniformBuffer,
        uniformData,
        uniformFloat32,
        uniformLayout: wp.uniformLayout,
        uniformBindGroup,
        textureBindGroup,
        resolution: wp.resolution,
      })
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  renderFrame(frame: ExportFrameUniforms): void {
    if (this.disposed) throw new Error('[export] renderFrame after dispose()')

    const maxTex = this.device.limits.maxTextureDimension2D
    const encoder = this.device.createCommandEncoder()

    for (let i = 0; i < this.passStates.length; i++) {
      const ps = this.passStates[i]
      const isLast = i === this.passStates.length - 1

      // The final pass always draws to the full-size offscreen target (u_dpr =
      // frame.uDpr). Intermediate passes honour their own `resolution`, and
      // passTargetSize scales u_dpr with the actual integer size so `auto_uv`
      // and anchor pinning stay invariant — the same rule the main renderer uses.
      const size = passTargetSize(ps.resolution, this.width, this.height, frame.uDpr, maxTex)
      const passW = isLast ? this.width : size.width
      const passH = isLast ? this.height : size.height
      const passDpr = isLast ? frame.uDpr : size.dpr

      writeBuiltinUniforms(ps.uniformFloat32, ps.uniformLayout, frame, passW, passH, passDpr)
      this.device.queue.writeBuffer(ps.uniformBuffer, 0, ps.uniformData, 0, ps.uniformLayout.totalSize)

      const targetView = isLast
        ? this.renderTexture.createView()
        : this.intermediateTextures[i].createView()

      const rp = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: targetView,
            loadOp: 'clear',
            storeOp: 'store',
            // Transparent clear so straight-alpha content keeps its alpha —
            // matches the main canvas (a: 0), NOT the opaque preview (a: 1).
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      })
      rp.setPipeline(ps.pipeline)
      rp.setBindGroup(0, ps.uniformBindGroup)
      if (ps.textureBindGroup) rp.setBindGroup(1, ps.textureBindGroup)
      rp.setVertexBuffer(0, this.quadBuffer)
      rp.draw(6)
      rp.end()
    }

    this.device.queue.submit([encoder.finish()])
    // Tag the new offscreen-texture contents so a `toVideoFrame` without a
    // matching `readback` is caught rather than silently reusing stale pixels.
    this.renderGeneration++
  }

  // -----------------------------------------------------------------------
  // Readback → un-premultiply → straight alpha
  // -----------------------------------------------------------------------

  async readback(): Promise<Uint8ClampedArray> {
    if (this.disposed) throw new Error('[export] readback after dispose()')

    // Serialise: one mapAsync on the staging buffer at a time.
    const prev = this.readbackLock
    let release!: () => void
    this.readbackLock = new Promise((r) => (release = r))
    await prev

    try {
      const encoder = this.device.createCommandEncoder()
      encoder.copyTextureToBuffer(
        { texture: this.renderTexture },
        { buffer: this.stagingBuffer, bytesPerRow: this.bytesPerRow },
        [this.width, this.height],
      )
      // Capture the generation these bytes belong to NOW, at copy-encode time —
      // a `renderFrame` racing during the await below must not mislabel them.
      const gen = this.renderGeneration
      this.device.queue.submit([encoder.finish()])

      await this.stagingBuffer.mapAsync(GPUMapMode.READ)
      const mapped = new Uint8Array(this.stagingBuffer.getMappedRange())

      // Strip row padding. WebGPU Y=0 is top → NO vertical flip (unlike WebGL2).
      const out = new Uint8ClampedArray(this.width * this.height * 4)
      const rowBytes = this.width * 4
      for (let y = 0; y < this.height; y++) {
        out.set(
          mapped.subarray(y * this.bytesPerRow, y * this.bytesPerRow + rowBytes),
          y * rowBytes,
        )
      }
      this.stagingBuffer.unmap()

      // Un-premultiply: the target is premultiplied. Only 0 < a < 255 pixels
      // need it — a = 0 (transparent) and a = 255 (opaque) are already straight.
      for (let i = 0; i < out.length; i += 4) {
        const a = out[i + 3]
        if (a > 0 && a < 255) {
          const s = 255 / a
          out[i] = Math.min(255, out[i] * s)
          out[i + 1] = Math.min(255, out[i + 1] * s)
          out[i + 2] = Math.min(255, out[i + 2] * s)
        }
      }

      this.lastPixels = out
      this.lastReadbackGeneration = gen
      return out
    } finally {
      release()
    }
  }

  // -----------------------------------------------------------------------
  // VideoFrame
  // -----------------------------------------------------------------------

  toVideoFrame(timestampUs: number): VideoFrame {
    if (this.disposed) throw new Error('[export] toVideoFrame after dispose()')
    // Guard against silently emitting a previous frame's pixels: the last
    // readback must belong to the CURRENT rendered frame. Covers both "no
    // readback ever" (-1 !== gen) and "stale readback" (an intervening
    // renderFrame bumped the generation past the last readback).
    if (this.renderGeneration !== this.lastReadbackGeneration || !this.lastPixels) {
      throw new Error(
        '[export] toVideoFrame() needs a readback() of the current frame first (last readback is stale)',
      )
    }

    if (!this.videoCanvas || !this.videoCtx) {
      this.videoCanvas = new OffscreenCanvas(this.width, this.height)
      // alpha: true keeps straight-alpha pixels intact through putImageData.
      this.videoCtx = this.videoCanvas.getContext('2d', {
        alpha: true,
      }) as OffscreenCanvasRenderingContext2D
      if (!this.videoCtx) throw new Error('[export] OffscreenCanvas 2D context unavailable')
    }

    // putImageData REPLACES (no blending), so straight-alpha values land exactly.
    const imageData = new ImageData(this.lastPixels, this.width, this.height)
    this.videoCtx.putImageData(imageData, 0, 0)

    // VideoFrame(CanvasImageSource) snapshots the canvas at construction, so the
    // reused canvas is safe to overwrite on the next frame.
    return new VideoFrame(this.videoCanvas, { timestamp: timestampUs })
  }

  // -----------------------------------------------------------------------
  // Texture bind groups (group 1)
  // -----------------------------------------------------------------------

  /**
   * Build group(1): each declared sampler is either an inter-pass texture
   * (bound to the producing pass's intermediate) or an image sampler (bound to
   * the image uploaded via the `images` map). A missing/undecodable image falls
   * back to a 1×1 transparent dummy so the bind group stays complete.
   */
  private buildTextureBindGroup(
    pipeline: GPURenderPipeline,
    textureBindings: TextureBinding[],
    inputTextures: Array<{ passIndex: number; samplerName: string }>,
  ): GPUBindGroup | null {
    if (textureBindings.length === 0) return null

    const entries: GPUBindGroupEntry[] = []
    for (const binding of textureBindings) {
      const passInput = inputTextures.find((it) => it.samplerName === binding.samplerName)
      if (passInput && passInput.passIndex < this.intermediateTextures.length) {
        entries.push({
          binding: binding.textureBinding,
          resource: this.intermediateTextures[passInput.passIndex].createView(),
        })
        entries.push({
          binding: binding.samplerBinding,
          resource: this.intermediateSamplers[passInput.passIndex],
        })
        continue
      }
      // Image sampler → the uploaded image texture, else a transparent dummy.
      const img = this.imageTextures.get(binding.samplerName)
      const texture = img?.texture ?? this.ensureDummy().texture
      const sampler = img?.sampler ?? this.ensureDummy().sampler
      entries.push({ binding: binding.textureBinding, resource: texture.createView() })
      entries.push({ binding: binding.samplerBinding, resource: sampler })
    }

    return this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries })
  }

  private ensureDummy(): { texture: GPUTexture; sampler: GPUSampler } {
    if (!this.dummyTexture) {
      this.dummyTexture = this.device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      // Explicit transparent black — a fresh texture is already zeroed, but be
      // explicit so intent is clear.
      this.device.queue.writeTexture(
        { texture: this.dummyTexture },
        new Uint8Array([0, 0, 0, 0]),
        { bytesPerRow: 4 },
        [1, 1],
      )
    }
    if (!this.dummySampler) {
      this.dummySampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })
    }
    return { texture: this.dummyTexture, sampler: this.dummySampler }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const ps of this.passStates) ps.uniformBuffer.destroy()
    for (const tex of this.intermediateTextures) tex.destroy()
    for (const { texture } of this.imageTextures.values()) texture.destroy()
    this.renderTexture.destroy()
    this.stagingBuffer.destroy()
    this.quadBuffer.destroy()
    this.dummyTexture?.destroy()
    // NB: the GPUDevice is SHARED with the main renderer — never destroy it here.
  }
}

// ---------------------------------------------------------------------------
// Uniform writers (dynamic offsets — never a hardcoded offset table)
// ---------------------------------------------------------------------------

/**
 * Write the built-in uniforms for one pass from `ExportFrameUniforms`, using
 * `layout.offsets` (dynamic). Only built-ins actually present in the map are
 * written. Byte order is never assumed — it comes from the offsets map.
 */
function writeBuiltinUniforms(
  f32: Float32Array,
  layout: UniformBufferLayout,
  frame: ExportFrameUniforms,
  passW: number,
  passH: number,
  passDpr: number,
): void {
  const off = layout.offsets
  const set1 = (name: string, v: number) => {
    const o = off.get(name)
    if (o != null) f32[o / 4] = v
  }
  const set2 = (name: string, a: number, b: number) => {
    const o = off.get(name)
    if (o != null) {
      f32[o / 4] = a
      f32[o / 4 + 1] = b
    }
  }
  set1('u_time', frame.timeSec)
  set2('u_resolution', passW, passH) // pass target size in device px
  set1('u_dpr', passDpr)
  set1('u_frame_scale', passDpr)
  set1('u_ref_size', REFERENCE_SIZE)
  set2('u_anchor', frame.anchor[0], frame.anchor[1])
  set2('u_viewport', passW, passH)
  set2('u_mouse', 0, 0)
}

/**
 * Write static user (node param) uniforms into the pass buffer, filtered to
 * names present in this pass's layout — mirrors `deserializeWGSLPasses`.
 */
function writeUserUniforms(
  f32: Float32Array,
  layout: UniformBufferLayout,
  values: Map<string, number | number[]>,
): void {
  for (const [name, value] of values) {
    const o = layout.offsets.get(name)
    if (o == null) continue
    const base = o / 4
    if (typeof value === 'number') {
      f32[base] = value
    } else {
      for (let i = 0; i < value.length; i++) f32[base + i] = value[i]
    }
  }
}
