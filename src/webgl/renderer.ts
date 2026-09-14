/**
 * WebGL2 fullscreen quad renderer with multi-pass support
 *
 * Single-pass graphs use the [P1] fast path — no FBOs, no extra state.
 * Multi-pass graphs render intermediate passes to FBO textures.
 */

import { REFERENCE_SIZE as SHARED_REFERENCE_SIZE } from '../renderer/constants'
import { captureCanvasThumbnail } from '../renderer/capture-thumbnail'
import type { RenderPlan } from '../compiler/glsl-generator'
import type { UniformSpec } from '../nodes/types'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import { passTargetSize, type PassTargetSize } from '../renderer/pass-size'

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const DEFAULT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = vec4(0.0, 0.0, 0.0, 1.0);
}
`

// QualityTier is now defined in src/renderer/types.ts
export type { QualityTier } from '../renderer/types'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PassState {
  index: number
  program: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation>
  userUniforms: UniformSpec[]
  inputTextures: Record<string, number>  // samplerName → source pass FBO index
  dirty: boolean
  isTimeLive: boolean
  textureFilter: number  // gl.LINEAR or gl.NEAREST
  /** Target scale for this pass. Undefined = full canvas resolution. */
  resolution?: number
  /**
   * Physical intermediate SLOT this pass renders into, or -1 when nothing
   * reads its output (always true of the final pass, which targets the
   * canvas instead). Undefined on a plan from an un-migrated compiler path —
   * callers fall back to one-slot-per-pass via `slotForPass()`. Multiple
   * passes may share a slot; see src/compiler/texture-slots.ts.
   */
  targetSlot?: number
  /**
   * True when NO other pass in the plan writes this pass's slot, so the slot's
   * contents survive untouched across any frame in which this pass is skipped.
   * Only such a pass may be skipped when clean — see the skip rule in
   * renderMultiPass(). Computed once per plan in updateRenderPlan(), since it
   * depends only on slot assignment.
   */
  soleWriterOfSlot: boolean
}

interface FBOSlot {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
  width: number
  height: number
}

interface ProgramCacheEntry {
  program: WebGLProgram
  lastUsed: number
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class WebGL2ShaderRenderer implements ShaderRenderer {
  readonly backend = 'webgl2' as const

  private canvas!: HTMLCanvasElement
  private gl!: WebGL2RenderingContext
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null

  // [P1] Single-pass state — used when isMultiPass is false
  private program: WebGLProgram | null = null
  private uniforms: Map<string, WebGLUniformLocation> = new Map()

  // Anchor point for coordinate origin (9-point grid, default center)
  private anchor: [number, number] = [0.5, 0.5]

  // Uniform value tracking for [P3] selective dirty marking
  private lastUniformValues: Map<string, number | number[]> = new Map()

  // Multi-pass state
  private isMultiPass = false
  private passStates: PassState[] = []
  private fboPool: FBOSlot[] = []
  private downstreamMap: Map<number, number[]> = new Map()
  private uniformPassMap: Map<string, number[]> = new Map()
  /** `plan.slotCount` for the current plan. Undefined on a plan from an
   *  un-migrated compiler path — `effectiveSlotCount()` then falls back to
   *  one slot per intermediate pass. */
  private planSlotCount?: number

  // [P6] Program cache — keyed by fragment shader source
  private programCache: Map<string, ProgramCacheEntry> = new Map()
  private static readonly PROGRAM_CACHE_MAX = 32

  // Animation
  private startTime: number = Date.now()
  private animationFrameId: number | null = null
  private animated = true
  private renderRequested = false
  private targetFps = 60
  private lastFrameTime = 0

  /** Monotonic count of frames actually drawn/presented (dev-only perf HUD reads
   *  deltas to derive delivered FPS). Cheap always-on counter. */
  private frameCount = 0

  // Quality tier
  private currentTier: QualityTier = 'adaptive'
  private ANIMATED_DPR_SCALE = 0.75
  private STATIC_DPR_SCALE = 1.0
  private currentDprScale = 1.0
  private lastAnimationSpeed = 1.0

  /** Fixed reference size for DPR-independent UV scaling in auto_uv and SRT translate (shared constant). */
  private static readonly REFERENCE_SIZE = SHARED_REFERENCE_SIZE

  // Resize
  private resizeObserver: ResizeObserver | null = null

  // [P9] GPU capabilities
  private maxTextureUnits = 16
  private maxIntermediateTextures = 8
  private maxTextureSize = 4096

  // Image textures (uploaded by image nodes)
  private imageTextures = new Map<string, WebGLTexture>()

  // [P5] Async compilation support (detected, used in future optimization)
  hasParallelCompile = false

  // Device/context loss callback
  private deviceLostCallback: (() => void) | null = null

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true })
    if (!gl) throw new Error('WebGL2 not supported')
    this.gl = gl

    this.initQuad()
    this.detectGPUCaps()
    this.setupContextLossHandlers()
    this.updateShader(DEFAULT_FRAGMENT_SHADER)

    this.resizeObserver = new ResizeObserver(() => {
      if (this.isMultiPass) this.resizeFBOs()
      this.requestRender()
    })
    this.resizeObserver.observe(canvas)
  }

  onDeviceLost(callback: () => void): void {
    this.deviceLostCallback = callback
  }

  // -----------------------------------------------------------------------
  // Initialization helpers
  // -----------------------------------------------------------------------

  private initQuad() {
    const gl = this.gl
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('Failed to create VAO')
    gl.bindVertexArray(vao)
    this.vao = vao

    const positions = new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ])

    this.buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  /** [P9] Query GPU capabilities and adjust limits. */
  private detectGPUCaps() {
    const gl = this.gl
    const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    this.maxTextureSize = maxTexSize
    this.maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number
    const rendererStr = gl.getParameter(gl.RENDERER) as string

    // Mobile / low-end heuristics
    const isMobile = /Mali|Adreno|Apple GPU|PowerVR|Tegra/i.test(rendererStr)
    if (maxTexSize < 4096 || isMobile) {
      this.maxIntermediateTextures = Math.min(4, this.maxTextureUnits - 1)
      // Force lower tier for mobile
      if (this.currentTier === 'adaptive' || this.currentTier === 'high') {
        this.setQualityTier('medium')
      }
    } else {
      // [P2] Hard cap: 8 intermediate textures
      this.maxIntermediateTextures = Math.min(8, this.maxTextureUnits - 1)
    }

    // [P5] Check for async compilation support
    this.hasParallelCompile = !!gl.getExtension('KHR_parallel_shader_compile')
  }

  /** [P10] Context loss recovery handlers. */
  private setupContextLossHandlers() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.stopAnimation()
      // All GL objects are now invalid
      this.program = null
      this.vao = null
      this.buffer = null
      this.uniforms.clear()
      this.passStates = []
      this.fboPool = []
      this.programCache.clear()
      // Image textures died with the context — drop the stale handles;
      // the consumer re-uploads via the restore callback below.
      this.imageTextures.clear()
    })

    this.canvas.addEventListener('webglcontextrestored', () => {
      // Re-create core resources
      this.initQuad()
      this.detectGPUCaps()
      this.updateShader(DEFAULT_FRAGMENT_SHADER)
      if (this.animated) this.startAnimation()
      // Fire AFTER restore (parity with the WebGPU recovery path): the
      // consumer re-applies the render plan and re-uploads image textures.
      this.deviceLostCallback?.()
    })
  }

  // -----------------------------------------------------------------------
  // Shader compilation
  // -----------------------------------------------------------------------

  private createShader(type: number, source: string): WebGLShader {
    const gl = this.gl
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Failed to create shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error('Shader compilation failed: ' + info)
    }
    return shader
  }

  private compileProgram(fragmentSource: string): WebGLProgram {
    const gl = this.gl
    let vs: WebGLShader | null = null
    let fs: WebGLShader | null = null
    let prog: WebGLProgram | null = null

    try {
      vs = this.createShader(gl.VERTEX_SHADER, VERTEX_SHADER)
      fs = this.createShader(gl.FRAGMENT_SHADER, fragmentSource)
      prog = gl.createProgram()
      if (!prog) throw new Error('Failed to create program')
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.bindAttribLocation(prog, 0, 'a_position')
      gl.linkProgram(prog)

      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(prog)
        throw new Error('Program linking failed: ' + info)
      }

      gl.deleteShader(vs)
      gl.deleteShader(fs)
      return prog
    } catch (err) {
      if (vs) gl.deleteShader(vs)
      if (fs) gl.deleteShader(fs)
      if (prog) gl.deleteProgram(prog)
      throw err
    }
  }

  /** [P6] Get or compile a program by fragment shader source. */
  private getOrCompileProgram(fragmentSource: string): WebGLProgram {
    const cached = this.programCache.get(fragmentSource)
    if (cached) {
      cached.lastUsed = Date.now()
      return cached.program
    }

    const program = this.compileProgram(fragmentSource)
    this.programCache.set(fragmentSource, { program, lastUsed: Date.now() })

    // LRU eviction
    if (this.programCache.size > WebGL2ShaderRenderer.PROGRAM_CACHE_MAX) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [key, entry] of this.programCache) {
        if (entry.lastUsed < oldestTime) {
          oldestKey = key
          oldestTime = entry.lastUsed
        }
      }
      if (oldestKey) {
        const evicted = this.programCache.get(oldestKey)!
        // Don't delete if it's the active single-pass program
        if (evicted.program !== this.program) {
          this.gl.deleteProgram(evicted.program)
        }
        this.programCache.delete(oldestKey)
      }
    }

    return program
  }

  /** Build uniform location cache for a program. */
  private buildUniformCache(program: WebGLProgram): Map<string, WebGLUniformLocation> {
    const gl = this.gl
    const cache = new Map<string, WebGLUniformLocation>()
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)
      if (info) {
        const location = gl.getUniformLocation(program, info.name)
        if (location) cache.set(info.name, location)
      }
    }
    return cache
  }

  // -----------------------------------------------------------------------
  // FBO management
  // -----------------------------------------------------------------------

  /**
   * Target size and matching u_dpr for every pass, honouring
   * RenderPass.resolution. `w`/`h` are the full render size in device px.
   */
  private passTargetSizes(w: number, h: number): PassTargetSize[] {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    return this.passStates.map((ps) =>
      passTargetSize(ps.resolution, w, h, dpr, this.maxTextureSize))
  }

  /**
   * Slot a pass's output lives in. Falls back to the pass's own index (the
   * old one-texture-per-pass scheme) when `targetSlot` is absent — the plan
   * came from an un-migrated compiler path.
   */
  private slotForPass(passIndex: number): number {
    const slot = this.passStates[passIndex]?.targetSlot
    return slot === undefined ? passIndex : slot
  }

  /**
   * Mark each pass with whether it is the ONLY pass that writes its slot.
   * Only those may be skipped when clean.
   *
   * The skip is a claim about the NEXT frame: "this pass's output is already
   * sitting in its slot, so don't redraw it". Under one-texture-per-pass that
   * was free — `fboPool[i]` could only ever hold pass i. Once a slot has more
   * than one writer, neither half of the claim survives:
   *
   *   - A LATER writer of the same slot overwrites it before the frame ends,
   *     so the skipped pass's image is already gone by the next frame.
   *   - An EARLIER writer overwrites it at the top of the next frame, before
   *     the skipped pass's consumer gets to sample it.
   *
   * Liveness only promises no one writes the slot between a pass and its last
   * reader WITHIN one frame; it says nothing about the gap that spans the frame
   * boundary, which is exactly the gap a skip opens. Both hazards vanish when a
   * slot has a single writer, and that is the rule.
   *
   * Cost: in a deep linear chain every slot has two writers, so no intermediate
   * pass is skippable there any more. Branch outputs — whose slots stay alive to
   * the end and so are never reused — keep the fast path. Correctness outranks
   * the saving, and the fallback backend is the only one with a skip to lose:
   * WebGPU renders every pass every frame regardless.
   *
   * A pass with slot -1 (nothing reads it) writes no intermediate at all, so
   * nothing can clobber it and it stays skippable. So does every pass on an
   * un-migrated plan, where `slotForPass()` falls back to the pass's own index
   * and no two passes can collide.
   */
  private computeSoleWriterOfSlot() {
    const writers = new Map<number, number>()
    for (let i = 0; i < this.passStates.length - 1; i++) {
      const slot = this.slotForPass(i)
      if (slot < 0) continue
      writers.set(slot, (writers.get(slot) ?? 0) + 1)
    }
    for (let i = 0; i < this.passStates.length - 1; i++) {
      const slot = this.slotForPass(i)
      this.passStates[i].soleWriterOfSlot = slot < 0 || writers.get(slot) === 1
    }
    // The final pass targets the canvas, not a slot; its own skip rule applies.
    const last = this.passStates[this.passStates.length - 1]
    if (last) last.soleWriterOfSlot = true
  }

  /** Number of physical intermediate textures this plan needs. Falls back to
   *  one per intermediate pass when `planSlotCount` is absent. */
  private effectiveSlotCount(): number {
    const numIntermediate = this.passStates.length - 1
    if (numIntermediate <= 0) return 0
    return this.planSlotCount ?? numIntermediate
  }

  /**
   * Size for each intermediate SLOT (not pass): sized from whichever pass
   * owns it (any of them will do — passes only share a slot when
   * texture-slots.ts bucketed them under the same `sizeKey`), but verified
   * rather than assumed, since a wrong-pass slot wiring bug would otherwise
   * surface only as a silently mis-sized (and therefore visibly wrong)
   * texture with no error.
   */
  private slotTargetSizes(w: number, h: number, cap: number): PassTargetSize[] {
    const passSizes = this.passTargetSizes(w, h)
    const sizes: PassTargetSize[] = []
    const ownerOfSlot: number[] = []
    for (let i = 0; i < this.passStates.length - 1; i++) {
      const slot = this.slotForPass(i)
      if (slot < 0 || slot >= cap) continue
      const size = passSizes[i]
      const existing = sizes[slot]
      if (existing === undefined) {
        sizes[slot] = size
        ownerOfSlot[slot] = i
      } else if (existing.width !== size.width || existing.height !== size.height) {
        console.error(
          `[Sombra] intermediate slot ${slot} sized by pass ${ownerOfSlot[slot]} ` +
          `(${existing.width}x${existing.height}) disagrees with pass ${i} (${size.width}x${size.height}) — ` +
          `texture-slot assignment should guarantee identical sizes per slot`,
        )
      }
    }
    // A slot with no owning pass shouldn't happen for a well-formed plan
    // (every slot is assigned by at least one pass), but still needs a size
    // to allocate a texture — fall back to full canvas size.
    for (let s = 0; s < cap; s++) {
      if (sizes[s] === undefined) sizes[s] = { width: w, height: h, dpr: 1 }
    }
    return sizes
  }

  /** Allocate FBO slots for intermediate passes, one per requested size. */
  private allocateFBOs(sizes: Array<{ width: number; height: number }>) {
    const gl = this.gl

    // Clean up existing
    this.destroyFBOs()

    const cappedCount = Math.min(sizes.length, this.maxIntermediateTextures)
    if (sizes.length > cappedCount) {
      console.warn(`[Sombra] Graph needs ${sizes.length} intermediate textures but cap is ${this.maxIntermediateTextures}. Some passes may not render.`)
    }

    for (let i = 0; i < cappedCount; i++) {
      const { width, height } = sizes[i]
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      // Default to LINEAR; per-pass filtering applied at bind time
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.bindTexture(gl.TEXTURE_2D, null)

      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)

      this.fboPool.push({ framebuffer: fb, texture: tex, width, height })
    }
  }

  /** Resize FBO textures to each SLOT's own target size. */
  private resizeFBOs() {
    const gl = this.gl
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const w = Math.floor(this.canvas.clientWidth * dpr)
    const h = Math.floor(this.canvas.clientHeight * dpr)
    const sizes = this.slotTargetSizes(w, h, this.fboPool.length)

    let resized = false
    for (let i = 0; i < this.fboPool.length; i++) {
      const fbo = this.fboPool[i]
      const want = sizes[i]
      if (!want) continue
      if (fbo.width === want.width && fbo.height === want.height) continue
      gl.bindTexture(gl.TEXTURE_2D, fbo.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, want.width, want.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      fbo.width = want.width
      fbo.height = want.height
      resized = true
    }

    // Only invalidate cached passes when something actually changed. This is now
    // also called as a per-frame revalidation from renderMultiPass, and marking
    // every pass dirty unconditionally would defeat the [P3] clean-pass skip and
    // re-render the whole chain every frame.
    if (resized) {
      for (const ps of this.passStates) ps.dirty = true
    }
  }

  private destroyFBOs() {
    const gl = this.gl
    for (const fbo of this.fboPool) {
      gl.deleteFramebuffer(fbo.framebuffer)
      gl.deleteTexture(fbo.texture)
    }
    this.fboPool = []
  }

  // -----------------------------------------------------------------------
  // Image texture management
  // -----------------------------------------------------------------------

  /** Upload (or replace) an image texture for a given sampler uniform name. */
  uploadImageTexture(samplerName: string, image: HTMLImageElement): void {
    const gl = this.gl
    if (gl.isContextLost()) return

    // Delete existing texture if present
    const existing = this.imageTextures.get(samplerName)
    if (existing) {
      gl.deleteTexture(existing)
    }

    const tex = gl.createTexture()
    if (!tex) return

    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, null)

    this.imageTextures.set(samplerName, tex)
    this.requestRender()
  }

  /** Delete an image texture by sampler name. */
  deleteImageTexture(samplerName: string): void {
    const gl = this.gl
    const tex = this.imageTextures.get(samplerName)
    if (tex) {
      if (!gl.isContextLost()) gl.deleteTexture(tex)
      this.imageTextures.delete(samplerName)
    }
  }

  /** Bind all image textures to texture units, starting at the given offset. Returns next free unit. */
  private bindImageTextures(
    uniforms: Map<string, WebGLUniformLocation>,
    startUnit: number,
  ): number {
    const gl = this.gl
    let unit = startUnit
    for (const [samplerName, tex] of this.imageTextures) {
      const loc = uniforms.get(samplerName)
      if (!loc) continue
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(loc, unit)
      unit++
    }
    return unit
  }

  // -----------------------------------------------------------------------
  // Public API: updateRenderPlan / updateShader
  // -----------------------------------------------------------------------

  /**
   * Apply a new render plan. Single-pass plans use the [P1] fast path.
   * Multi-pass plans compile per-pass programs and allocate FBOs.
   */
  updateRenderPlan(plan: RenderPlan): { success: boolean; error?: string } {
    if (!plan.success || plan.passes.length === 0) {
      return { success: false, error: 'Invalid render plan' }
    }

    // New programs need all uniforms uploaded fresh — clear the "already sent" cache
    this.lastUniformValues.clear()

    // [P1] Single-pass fast path — bypass FBO setup entirely
    if (plan.passes.length === 1) {
      this.isMultiPass = false
      this.cleanupMultiPassState()
      return this.installSinglePassProgram(plan.passes[0].fragmentShader)
    }

    // Multi-pass setup.
    //
    // Reject an over-cap plan instead of allocating a truncated FBO pool.
    // Silently capping is worse than a hard failure: renderMultiPass skips a
    // pass with no FBO and `continue`s WITHOUT setting the consumer's sampler
    // uniform, so that sampler keeps its default of texture unit 0 and the
    // consumer samples whatever happens to be bound there — a plausible-looking
    // but wrong image, reported as success. Reachable today: Pyramid Blur at
    // N=3 is already 7 passes.
    //
    // Compare against SLOTS, not passes: a plan with `slotCount` reuses
    // textures across non-overlapping-lifetime passes, so a deep pass chain
    // can need far fewer physical textures than it has passes. Absent
    // `slotCount` (an un-migrated plan) falls back to the old one-per-pass count.
    const intermediateCount = plan.passes.length - 1
    const effectiveSlots = plan.slotCount ?? intermediateCount
    if (effectiveSlots > this.maxIntermediateTextures) {
      return {
        success: false,
        error: `Graph needs ${effectiveSlots} intermediate render targets (max ${this.maxIntermediateTextures}) — reduce effect chain depth`,
      }
    }

    this.isMultiPass = true
    this.planSlotCount = plan.slotCount

    try {
      const newPassStates: PassState[] = []

      for (const pass of plan.passes) {
        // [P6] Use cached program if shader hasn't changed
        const program = this.getOrCompileProgram(pass.fragmentShader)
        const uniformCache = this.buildUniformCache(program)

        // [P7] Determine texture filtering
        const filterHint = pass.textureFilter ?? 'linear'
        const glFilter = filterHint === 'nearest' ? this.gl.NEAREST : this.gl.LINEAR

        newPassStates.push({
          index: pass.index,
          program,
          uniforms: uniformCache,
          userUniforms: pass.userUniforms,
          inputTextures: pass.inputTextures,
          dirty: true,
          isTimeLive: pass.isTimeLive,
          textureFilter: glFilter,
          resolution: pass.resolution,
          targetSlot: pass.targetSlot,
          // Provisional — computed for real below, once every pass's slot is known.
          soleWriterOfSlot: true,
        })
      }

      // Clean up old multi-pass state
      this.passStates = newPassStates
      this.computeSoleWriterOfSlot()

      // Build downstream map for dirty propagation [P3]
      this.buildDownstreamMap()

      // Build uniform → pass routing map
      this.buildUniformPassMap()

      // Allocate FBOs for intermediate SLOTS (not passes — several passes may
      // share one when their lifetimes don't overlap; see texture-slots.ts).
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
      const w = Math.floor(this.canvas.clientWidth * dpr) || 1
      const h = Math.floor(this.canvas.clientHeight * dpr) || 1
      // passStates is already assigned above, so slotTargetSizes sees this plan.
      this.allocateFBOs(this.slotTargetSizes(w, h, this.effectiveSlotCount()))

      // Clear single-pass program ref (it's in the cache now)
      this.program = null

      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[Sombra] Multi-pass setup failed:', msg)
      return { success: false, error: msg }
    }
  }

  /**
   * Backward-compatible shader update. Creates a single-pass plan internally.
   */
  updateShader(fragmentSource: string): { success: boolean; error?: string } {
    this.isMultiPass = false
    this.cleanupMultiPassState()
    return this.installSinglePassProgram(fragmentSource)
  }

  private installSinglePassProgram(fragmentSource: string): { success: boolean; error?: string } {
    try {
      const program = this.getOrCompileProgram(fragmentSource)

      // Install as active single-pass program
      if (this.program && this.program !== program) {
        // Old program stays in cache — don't delete it
      }
      this.program = program
      this.gl.useProgram(program)
      this.uniforms = this.buildUniformCache(program)

      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('Failed to update shader:', msg)
      return { success: false, error: msg }
    }
  }

  private cleanupMultiPassState() {
    if (this.fboPool.length > 0) this.destroyFBOs()
    this.passStates = []
    this.downstreamMap.clear()
    this.uniformPassMap.clear()
    this.lastUniformValues.clear()
    this.planSlotCount = undefined
  }

  /** [P3] Build downstream adjacency from inputTextures. */
  private buildDownstreamMap() {
    this.downstreamMap.clear()
    for (const ps of this.passStates) {
      for (const sourcePassIdx of Object.values(ps.inputTextures)) {
        const existing = this.downstreamMap.get(sourcePassIdx) || []
        existing.push(ps.index)
        this.downstreamMap.set(sourcePassIdx, existing)
      }
    }
  }

  /** Build uniform name → pass indices routing map (one uniform may span multiple passes). */
  private buildUniformPassMap() {
    this.uniformPassMap.clear()
    for (const ps of this.passStates) {
      for (const spec of ps.userUniforms) {
        const existing = this.uniformPassMap.get(spec.name)
        if (existing) {
          if (!existing.includes(ps.index)) existing.push(ps.index)
        } else {
          this.uniformPassMap.set(spec.name, [ps.index])
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Uniform updates
  // -----------------------------------------------------------------------

  updateUniforms(uniforms: Array<{ name: string; value: number | number[] }>) {
    const gl = this.gl
    if (gl.isContextLost()) return

    if (!this.isMultiPass) {
      // Single-pass: same as before
      if (!this.program) return
      gl.useProgram(this.program)
      for (const { name, value } of uniforms) {
        const loc = this.uniforms.get(name)
        if (!loc) continue
        this.uploadUniform(loc, value)
      }
      this.requestRender()
      return
    }

    // Multi-pass: route each uniform to ALL its passes (re-emitted nodes span multiple)
    let anyChanged = false
    for (const { name, value } of uniforms) {
      // [P3] Skip if value unchanged — avoids marking unrelated passes dirty
      if (!this.uniformValueChanged(name, value)) continue
      this.lastUniformValues.set(name, value)

      const passIndices = this.uniformPassMap.get(name)
      if (!passIndices) continue

      for (const passIdx of passIndices) {
        const ps = this.passStates[passIdx]
        if (!ps) continue

        gl.useProgram(ps.program)
        const loc = ps.uniforms.get(name)
        if (loc) this.uploadUniform(loc, value)

        // [P3] Mark affected pass + downstream as dirty
        this.markPassDirty(passIdx)
      }
      anyChanged = true
    }

    if (anyChanged) this.requestRender()
  }

  /** [P3] Check if a uniform value actually changed from last upload. */
  private uniformValueChanged(name: string, value: number | number[]): boolean {
    const prev = this.lastUniformValues.get(name)
    if (prev === undefined) return true
    if (typeof value === 'number') return prev !== value
    if (typeof prev === 'number') return true
    if (!Array.isArray(prev) || prev.length !== (value as number[]).length) return true
    for (let i = 0; i < (value as number[]).length; i++) {
      if (prev[i] !== (value as number[])[i]) return true
    }
    return false
  }

  private uploadUniform(loc: WebGLUniformLocation, value: number | number[]) {
    const gl = this.gl
    if (typeof value === 'number') {
      gl.uniform1f(loc, value)
    } else if (Array.isArray(value)) {
      if (value.length === 2) gl.uniform2f(loc, value[0], value[1])
      else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2])
      else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3])
    }
  }

  /** [P3] Mark a pass and all downstream passes as dirty. */
  private markPassDirty(passIndex: number) {
    const ps = this.passStates[passIndex]
    if (!ps || ps.dirty) return
    ps.dirty = true
    const downstream = this.downstreamMap.get(passIndex)
    if (downstream) {
      for (const idx of downstream) this.markPassDirty(idx)
    }
  }

  /** Mark all passes dirty (used on structural changes). */
  markAllDirty() {
    for (const ps of this.passStates) ps.dirty = true
  }

  // -----------------------------------------------------------------------
  // Animation / quality tier
  // -----------------------------------------------------------------------

  setAnimated(animated: boolean) {
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
    if (this.isMultiPass) this.resizeFBOs()
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

  requestRender() {
    if (this.animated || this.renderRequested) return
    this.renderRequested = true
    requestAnimationFrame(() => {
      this.renderRequested = false
      this.render()
    })
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  render() {
    const gl = this.gl
    if (!this.vao) return
    if (gl.isContextLost()) return

    // Update canvas size
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const displayWidth = Math.floor(this.canvas.clientWidth * dpr)
    const displayHeight = Math.floor(this.canvas.clientHeight * dpr)
    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth
      this.canvas.height = displayHeight
    }

    const time = (Date.now() - this.startTime) / 1000

    if (this.isMultiPass && this.passStates.length > 1) {
      this.renderMultiPass(displayWidth, displayHeight, dpr, time)
    } else {
      this.renderSinglePass(displayWidth, displayHeight, dpr, time)
    }
  }

  captureThumbnail(): string | null {
    // The WebGL2 context has no preserveDrawingBuffer, so the drawing buffer is
    // valid only within the tick that drew it. Render and read back in the same
    // synchronous call — otherwise the readback lands on a cleared (black) buffer.
    this.render()
    return captureCanvasThumbnail(this.canvas)?.dataUrl ?? null
  }

  /** [P1] Single-pass render — identical to pre-Phase-6 behavior. */
  private renderSinglePass(w: number, h: number, dpr: number, time: number) {
    const gl = this.gl
    if (!this.program) return

    gl.viewport(0, 0, w, h)
    gl.useProgram(this.program)
    this.uploadBuiltinUniforms(this.uniforms, w, h, dpr, time)

    // Bind image textures (starting at texture unit 0 for single-pass)
    this.bindImageTextures(this.uniforms, 0)

    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
    this.frameCount++
  }

  /** Multi-pass render with FBOs. */
  private renderMultiPass(w: number, h: number, dpr: number, time: number) {
    const gl = this.gl

    // The pool can be stale relative to the size we are about to render at.
    // setAnimated() changes currentDprScale without resizing, and notifyChange()'s
    // tier restore does the same — so intermediates would rasterise at the OLD
    // fbo.width/height while u_viewport is uploaded at the NEW size, giving a
    // whole-frame scale error plus an anchor offset that persists until some
    // unrelated layout resize. It also fires on first load, since `animated`
    // starts true while currentDprScale is still 1.0.
    // One guarded revalidation covers every path, mirroring WebGPU, where
    // ensureIntermediateTextures() is already the first statement of its
    // equivalent. Guarded because resizeFBOs() is a no-op only when nothing moved.
    //
    // Compare EVERY pass, not just fboPool[0]. With mixed per-pass scales a
    // single comparison mis-fires and the pool is destroyed and recreated every
    // frame — the bug already recorded at src/webgpu/renderer.ts:456.
    //
    // Computed ONCE and reused for both the staleness check and the per-pass
    // uniform upload below: `passTargetSizes` reads only w/h, each pass's
    // declared scale, `currentDprScale` and `maxTextureSize`, and `resizeFBOs()`
    // touches none of those — so a second call could only ever return the same
    // array, at the cost of another `passStates.length` allocations every frame.
    const sizes = this.passTargetSizes(w, h)
    if (this.fboPool.length > 0) {
      // Staleness is a SLOT property (the FBO pool is indexed by slot), not a
      // pass property — comparing fboPool[i] against the i-th PASS's size
      // would misalign as soon as passes outnumber slots.
      const slotSizes = this.slotTargetSizes(w, h, this.fboPool.length)
      const stale = this.fboPool.some((f, s) =>
        !!slotSizes[s] && (f.width !== slotSizes[s].width || f.height !== slotSizes[s].height))
      if (stale) this.resizeFBOs()
    }

    // [P3] Mark time-live passes + downstream as dirty (animation)
    if (this.animated) {
      for (const ps of this.passStates) {
        if (ps.isTimeLive) this.markPassDirty(ps.index)
      }
    }

    gl.bindVertexArray(this.vao)

    for (let i = 0; i < this.passStates.length; i++) {
      const ps = this.passStates[i]
      const isLast = i === this.passStates.length - 1

      // [P3] Skip clean intermediate passes — but ONLY when this pass is the
      // sole writer of its slot, so nothing else can have overwritten the
      // output we are claiming is still there. A slot with several writers ends
      // the frame holding its LAST writer's output, and starts the next frame
      // being rewritten by its FIRST — either way a skipped pass's image is not
      // what its consumer reads. See computeSoleWriterOfSlot().
      // (gradient → 4× pixelate gives slots [0,1,0,1,-1]: dirtying only pass 1
      // downward used to leave pass 1 reading pass 3's previous frame.)
      if (!ps.dirty && !isLast && ps.soleWriterOfSlot) continue
      // Last pass always renders (to screen)
      if (!ps.dirty && isLast && !this.animated) continue

      let tw = w, th = h, tdpr = dpr
      if (isLast) {
        // Render to screen — always full canvas resolution.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      } else {
        // Render to FBO, at this pass's own target size (RenderPass.resolution).
        // Target the pass's SLOT, not its own index — several passes may
        // share a slot when their lifetimes don't overlap.
        const slot = this.slotForPass(i)
        const fbo = this.fboPool[slot]
        if (!fbo) continue
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer)
        tw = fbo.width
        th = fbo.height
        tdpr = sizes[i]?.dpr ?? dpr
      }
      gl.viewport(0, 0, tw, th)

      gl.useProgram(ps.program)
      this.uploadBuiltinUniforms(ps.uniforms, tw, th, tdpr, time)

      // Bind input textures from earlier passes
      let texUnit = 0
      for (const [samplerName, sourcePassIdx] of Object.entries(ps.inputTextures)) {
        // Read from the source pass's SLOT, not its own index. Within a frame
        // this is safe by liveness: the source's slot is not handed to another
        // pass until after its last reader (us, or someone later) has run.
        // ACROSS frames it is not — at end of frame a slot holds whichever of
        // its writers ran LAST, and the next frame starts rewriting it from its
        // FIRST. So a source that did not render this frame is only trustworthy
        // when it is the slot's only writer. That is what the skip rule above
        // guarantees: a pass sharing its slot is never skipped.
        const sourceSlot = this.slotForPass(sourcePassIdx)
        const sourceFbo = this.fboPool[sourceSlot]
        if (!sourceFbo) continue

        // A boundary whose sampler this program does not have is one the GLSL
        // compiler stripped as unused. Skip it WITHOUT spending a unit: the
        // increment used to run regardless, so every unread boundary pushed the
        // image samplers that follow (bindImageTextures continues from this
        // counter) one unit further, past MAX_TEXTURE_IMAGE_UNITS. There is no
        // getError in this loop, so activeTexture's GL_INVALID_ENUM goes
        // unnoticed and the draw fails to a stale or black canvas. The linker
        // cannot catch it either — it counts ACTIVE samplers, and these are
        // precisely the ones it dropped.
        const samplerLoc = ps.uniforms.get(samplerName)
        if (!samplerLoc) continue

        gl.activeTexture(gl.TEXTURE0 + texUnit)
        gl.bindTexture(gl.TEXTURE_2D, sourceFbo.texture)

        // [P7] Apply per-pass texture filtering from the SOURCE pass
        const sourceState = this.passStates[sourcePassIdx]
        if (sourceState) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sourceState.textureFilter)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sourceState.textureFilter)
        }

        gl.uniform1i(samplerLoc, texUnit)
        texUnit++
      }

      // Bind image textures after FBO textures
      this.bindImageTextures(ps.uniforms, texUnit)

      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // Unbind FBO (not strictly necessary for intermediate, but clean)
      if (!isLast) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      }

      ps.dirty = false
    }

    // Clean up texture bindings
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindVertexArray(null)
    this.frameCount++
  }

  /** Upload built-in uniforms (time, resolution, ref_size, dpr) to a program. */
  private uploadBuiltinUniforms(
    uniforms: Map<string, WebGLUniformLocation>,
    w: number, h: number, dpr: number, time: number,
  ) {
    const gl = this.gl
    const timeLoc = uniforms.get('u_time')
    if (timeLoc) gl.uniform1f(timeLoc, time)

    const resLoc = uniforms.get('u_resolution')
    if (resLoc) gl.uniform2f(resLoc, w, h)

    const dprLoc = uniforms.get('u_dpr')
    if (dprLoc) gl.uniform1f(dprLoc, dpr)

    const frameScaleLoc = uniforms.get('u_frame_scale')
    if (frameScaleLoc) gl.uniform1f(frameScaleLoc, dpr)

    const refLoc = uniforms.get('u_ref_size')
    if (refLoc) gl.uniform1f(refLoc, WebGL2ShaderRenderer.REFERENCE_SIZE)

    const vpLoc = uniforms.get('u_viewport')
    if (vpLoc) gl.uniform2f(vpLoc, w, h)

    const anchorLoc = uniforms.get('u_anchor')
    if (anchorLoc) gl.uniform2f(anchorLoc, this.anchor[0], this.anchor[1])
  }

  /** Monotonic count of frames actually drawn. Dev/perf HUD samples deltas over
   *  an interval to compute delivered FPS. Always-on, negligible cost. */
  getFrameCount(): number { return this.frameCount }

  /** Current target FPS cap the animation loop throttles to (30/45/60). */
  getTargetFps(): number { return this.targetFps }

  // -----------------------------------------------------------------------
  // Animation loop
  // -----------------------------------------------------------------------

  startAnimation() {
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

  stopAnimation() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Clear the canvas to black and stop animation. Used when compilation fails. */
  clear() {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.setAnimated(false)
  }

  dispose() {
    this.stopAnimation()
    this.resizeObserver?.disconnect()

    this.destroyFBOs()

    // Clean up image textures
    for (const [name] of this.imageTextures) {
      this.deleteImageTexture(name)
    }

    const gl = this.gl
    // Delete cached programs
    for (const entry of this.programCache.values()) {
      gl.deleteProgram(entry.program)
    }
    this.programCache.clear()

    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.buffer) gl.deleteBuffer(this.buffer)
  }
}
