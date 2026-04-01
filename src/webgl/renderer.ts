/**
 * WebGL2 fullscreen quad renderer with multi-pass support
 *
 * Single-pass graphs use the [P1] fast path — no FBOs, no extra state.
 * Multi-pass graphs render intermediate passes to FBO textures.
 */

import type { RenderPlan } from '../compiler/glsl-generator'
import type { UniformSpec } from '../nodes/types'

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

export type QualityTier = 'adaptive' | 'low' | 'medium' | 'high'

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

export class WebGLRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private vao: WebGLVertexArrayObject | null = null
  private buffer: WebGLBuffer | null = null

  // [P1] Single-pass state — used when isMultiPass is false
  private program: WebGLProgram | null = null
  private uniforms: Map<string, WebGLUniformLocation> = new Map()

  // Uniform value tracking for [P3] selective dirty marking
  private lastUniformValues: Map<string, number | number[]> = new Map()

  // Multi-pass state
  private isMultiPass = false
  private passStates: PassState[] = []
  private fboPool: FBOSlot[] = []
  private downstreamMap: Map<number, number[]> = new Map()
  private uniformPassMap: Map<string, number[]> = new Map()

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

  // Quality tier
  private currentTier: QualityTier = 'adaptive'
  private ANIMATED_DPR_SCALE = 0.75
  private STATIC_DPR_SCALE = 1.0
  private currentDprScale = 1.0
  private snapTimer: ReturnType<typeof setTimeout> | null = null
  private lastAnimationSpeed = 1.0

  // Reference size (frozen on first render)
  /** Frozen CSS-pixel min(width, height) — used with u_dpr in auto_uv for DPR-independent scaling */
  private refSize: number | null = null

  // Resize
  private resizeObserver: ResizeObserver | null = null

  // [P9] GPU capabilities
  private maxTextureUnits = 16
  private maxIntermediateTextures = 8

  // Image textures (uploaded by image nodes)
  private imageTextures = new Map<string, WebGLTexture>()

  // [P5] Async compilation support (detected, used in future optimization)
  hasParallelCompile = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2')
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
    })

    this.canvas.addEventListener('webglcontextrestored', () => {
      // Re-create core resources
      this.initQuad()
      this.detectGPUCaps()
      this.updateShader(DEFAULT_FRAGMENT_SHADER)
      if (this.animated) this.startAnimation()
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
    if (this.programCache.size > WebGLRenderer.PROGRAM_CACHE_MAX) {
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

  /** Allocate FBO slots for intermediate passes. */
  private allocateFBOs(count: number, width: number, height: number) {
    const gl = this.gl

    // Clean up existing
    this.destroyFBOs()

    const cappedCount = Math.min(count, this.maxIntermediateTextures)
    if (count > cappedCount) {
      console.warn(`[Sombra] Graph needs ${count} intermediate textures but cap is ${this.maxIntermediateTextures}. Some passes may not render.`)
    }

    for (let i = 0; i < cappedCount; i++) {
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

  /** Resize all FBO textures to match current canvas size. */
  private resizeFBOs() {
    const gl = this.gl
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const w = Math.floor(this.canvas.clientWidth * dpr)
    const h = Math.floor(this.canvas.clientHeight * dpr)

    for (const fbo of this.fboPool) {
      if (fbo.width === w && fbo.height === h) continue
      gl.bindTexture(gl.TEXTURE_2D, fbo.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      fbo.width = w
      fbo.height = h
    }

    // Mark all passes dirty after resize
    for (const ps of this.passStates) ps.dirty = true
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

    // Multi-pass setup
    this.isMultiPass = true

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
        })
      }

      // Clean up old multi-pass state
      this.passStates = newPassStates

      // Build downstream map for dirty propagation [P3]
      this.buildDownstreamMap()

      // Build uniform → pass routing map
      this.buildUniformPassMap()

      // Allocate FBOs for intermediate passes (all except last)
      const intermediateCount = plan.passes.length - 1
      const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
      const w = Math.floor(this.canvas.clientWidth * dpr) || 1
      const h = Math.floor(this.canvas.clientHeight * dpr) || 1
      this.allocateFBOs(intermediateCount, w, h)

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
    if (this.isMultiPass) this.resizeFBOs()
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
        if (this.isMultiPass) this.resizeFBOs()
        this.render()
        this.currentDprScale = this.ANIMATED_DPR_SCALE
        if (this.isMultiPass) this.resizeFBOs()
      }
    }, 2000)
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

    // Freeze reference size on first valid render (CSS pixels, DPR-independent)
    if (this.refSize === null && this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) {
      this.refSize = Math.min(this.canvas.clientWidth, this.canvas.clientHeight)
    }

    const time = (Date.now() - this.startTime) / 1000

    if (this.isMultiPass && this.passStates.length > 1) {
      this.renderMultiPass(displayWidth, displayHeight, dpr, time)
    } else {
      this.renderSinglePass(displayWidth, displayHeight, dpr, time)
    }
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
  }

  /** Multi-pass render with FBOs. */
  private renderMultiPass(w: number, h: number, dpr: number, time: number) {
    const gl = this.gl

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

      // [P3] Skip clean intermediate passes
      if (!ps.dirty && !isLast) continue
      // Last pass always renders (to screen)
      if (!ps.dirty && isLast && !this.animated) continue

      if (isLast) {
        // Render to screen
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, w, h)
      } else {
        // Render to FBO
        const fbo = this.fboPool[i]
        if (!fbo) continue
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer)
        gl.viewport(0, 0, fbo.width, fbo.height)
      }

      gl.useProgram(ps.program)
      this.uploadBuiltinUniforms(ps.uniforms, w, h, dpr, time)

      // Bind input textures from earlier passes
      let texUnit = 0
      for (const [samplerName, sourcePassIdx] of Object.entries(ps.inputTextures)) {
        const sourceFbo = this.fboPool[sourcePassIdx]
        if (!sourceFbo) continue

        gl.activeTexture(gl.TEXTURE0 + texUnit)
        gl.bindTexture(gl.TEXTURE_2D, sourceFbo.texture)

        // [P7] Apply per-pass texture filtering from the SOURCE pass
        const sourceState = this.passStates[sourcePassIdx]
        if (sourceState) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sourceState.textureFilter)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sourceState.textureFilter)
        }

        const samplerLoc = ps.uniforms.get(samplerName)
        if (samplerLoc) gl.uniform1i(samplerLoc, texUnit)
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

    const refLoc = uniforms.get('u_ref_size')
    if (refLoc && this.refSize !== null) gl.uniform1f(refLoc, this.refSize)

    const vpLoc = uniforms.get('u_viewport')
    if (vpLoc) gl.uniform2f(vpLoc, w, h)
  }

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
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.setAnimated(false)
  }

  destroy() {
    this.stopAnimation()
    if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null }
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
