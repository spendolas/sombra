/**
 * Offscreen WebGL2 renderer for per-node preview thumbnails.
 * Uses a single offscreen canvas + FBO to render subgraph shaders
 * and read pixels back as ImageBitmaps for zero-copy canvas display.
 */

import type { PreviewRenderer as IPreviewRenderer } from '../renderer/types'

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const PREVIEW_SIZE = 80

/** Frozen reference size — must match the main renderer's REFERENCE_SIZE. */
const REFERENCE_SIZE = 512

export interface UniformUpload {
  name: string
  value: number | number[]
}

export class WebGL2PreviewRenderer implements IPreviewRenderer {
  readonly backend = 'webgl2' as const

  private gl!: WebGL2RenderingContext
  private vao!: WebGLVertexArrayObject
  private fbo!: WebGLFramebuffer
  private fboTexture!: WebGLTexture
  private vertexShader!: WebGLShader
  private programCache = new Map<string, WebGLProgram>()
  private cacheOrder: string[] = []
  private readonly MAX_CACHE = 64
  private readBuf = new Uint8Array(PREVIEW_SIZE * PREVIEW_SIZE * 4)
  private startTime = Date.now()
  /** Reusable OffscreenCanvas for zero-copy ImageBitmap conversion (separate from WebGL canvas) */
  private canvas2d = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE)
  private ctx2d = this.canvas2d.getContext('2d')!

  async init(): Promise<void> {
    // Offscreen WebGL canvas (never added to DOM)
    const canvas = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE)
    const gl = canvas.getContext('webgl2')
    if (!gl) throw new Error('WebGL2 not supported for preview renderer')
    this.gl = gl

    // Quad VAO
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1, -1, 1,
      -1,  1,  1, -1,  1, 1,
    ]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.vao = vao

    // Compile the shared vertex shader once
    this.vertexShader = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER)

    // FBO + texture
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PREVIEW_SIZE, PREVIEW_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    this.fboTexture = tex

    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.fbo = fbo
  }

  /**
   * Update the main canvas resolution so pixel-based uniforms
   * (e.g. ribWidth) compute the same UV fractions as the full render.
   */
  setMainResolution(_width: number, _height: number) {
    // No-op: preview now uses PREVIEW_SIZE for all uniforms
  }

  /**
   * Render a fragment shader and return an ImageBitmap, or null on compile error.
   */
  async renderPreview(fragmentShader: string, uniforms: UniformUpload[]): Promise<ImageBitmap | null> {
    const gl = this.gl

    // Get or compile program (LRU cache)
    let program = this.programCache.get(fragmentShader) ?? null
    if (program) {
      // Move to end of LRU order on hit
      const idx = this.cacheOrder.indexOf(fragmentShader)
      if (idx !== -1) {
        this.cacheOrder.splice(idx, 1)
        this.cacheOrder.push(fragmentShader)
      }
    } else {
      program = this.buildProgram(fragmentShader)
      if (!program) return null
      if (this.cacheOrder.length >= this.MAX_CACHE) {
        const evict = this.cacheOrder.shift()!
        const old = this.programCache.get(evict)
        if (old) gl.deleteProgram(old)
        this.programCache.delete(evict)
      }
      this.programCache.set(fragmentShader, program)
      this.cacheOrder.push(fragmentShader)
    }

    gl.useProgram(program)

    // Upload built-in uniforms
    const uTime = gl.getUniformLocation(program, 'u_time')
    if (uTime) gl.uniform1f(uTime, (Date.now() - this.startTime) / 1000)

    const uRes = gl.getUniformLocation(program, 'u_resolution')
    if (uRes) gl.uniform2f(uRes, PREVIEW_SIZE, PREVIEW_SIZE)

    const uRefSize = gl.getUniformLocation(program, 'u_ref_size')
    if (uRefSize) gl.uniform1f(uRefSize, REFERENCE_SIZE)

    const uMouse = gl.getUniformLocation(program, 'u_mouse')
    if (uMouse) gl.uniform2f(uMouse, 0, 0)

    const uDpr = gl.getUniformLocation(program, 'u_dpr')
    if (uDpr) gl.uniform1f(uDpr, 1.0)

    const uVp = gl.getUniformLocation(program, 'u_viewport')
    if (uVp) gl.uniform2f(uVp, PREVIEW_SIZE, PREVIEW_SIZE)

    const uAnchor = gl.getUniformLocation(program, 'u_anchor')
    if (uAnchor) gl.uniform2f(uAnchor, 0.5, 0.5)

    // Upload user uniforms
    for (const u of uniforms) {
      const loc = gl.getUniformLocation(program, u.name)
      if (!loc) continue
      if (typeof u.value === 'number') {
        gl.uniform1f(loc, u.value)
      } else if (u.value.length === 2) {
        gl.uniform2f(loc, u.value[0], u.value[1])
      } else if (u.value.length === 3) {
        gl.uniform3f(loc, u.value[0], u.value[1], u.value[2])
      } else if (u.value.length === 4) {
        gl.uniform4f(loc, u.value[0], u.value[1], u.value[2], u.value[3])
      }
    }

    // Render to FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Read pixels
    gl.readPixels(0, 0, PREVIEW_SIZE, PREVIEW_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // Convert to ImageBitmap via reusable OffscreenCanvas (zero PNG encoding)
    // WebGL reads bottom-up, so flip vertically
    const imageData = new ImageData(PREVIEW_SIZE, PREVIEW_SIZE)
    for (let y = 0; y < PREVIEW_SIZE; y++) {
      const srcRow = (PREVIEW_SIZE - 1 - y) * PREVIEW_SIZE * 4
      const dstRow = y * PREVIEW_SIZE * 4
      imageData.data.set(this.readBuf.subarray(srcRow, srcRow + PREVIEW_SIZE * 4), dstRow)
    }
    return this.renderToImageBitmap(imageData)
  }

  /**
   * Convert ImageData to ImageBitmap via a reusable OffscreenCanvas.
   * transferToImageBitmap() is synchronous and avoids PNG encoding entirely.
   */
  private renderToImageBitmap(imageData: ImageData): ImageBitmap {
    this.ctx2d.putImageData(imageData, 0, 0)
    return this.canvas2d.transferToImageBitmap()
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || 'Unknown error'
      gl.deleteShader(shader)
      throw new Error(`Shader compile error: ${log}`)
    }
    return shader
  }

  private buildProgram(fragmentSource: string): WebGLProgram | null {
    const gl = this.gl
    let fragShader: WebGLShader
    try {
      fragShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource)
    } catch (e) {
      console.warn('[preview-renderer] shader compile error:', e instanceof Error ? e.message : e)
      return null
    }

    const program = gl.createProgram()!
    gl.attachShader(program, this.vertexShader)
    gl.attachShader(program, fragShader)
    gl.linkProgram(program)
    gl.deleteShader(fragShader)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[preview-renderer] program link error:', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return null
    }

    return program
  }

  /**
   * Render a multi-pass preview chain. Uses a pair of 80×80 FBOs for ping-pong. [P8]
   */
  async renderMultiPassPreview(
    passes: Array<{ fragmentShader: string; uniforms: UniformUpload[]; inputTextures: Record<string, number> }>,
  ): Promise<ImageBitmap | null> {
    const gl = this.gl
    if (passes.length === 0) return null

    // Single pass → delegate to existing method
    if (passes.length === 1) {
      return this.renderPreview(passes[0].fragmentShader, passes[0].uniforms)
    }

    // Allocate temp FBO pair for ping-pong (lazy, reused across calls)
    this.ensurePingPongFBOs()

    const time = (Date.now() - this.startTime) / 1000

    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i]
      const isLast = i === passes.length - 1

      // Get or compile program (LRU cache)
      let program = this.programCache.get(pass.fragmentShader) ?? null
      if (program) {
        const idx = this.cacheOrder.indexOf(pass.fragmentShader)
        if (idx !== -1) {
          this.cacheOrder.splice(idx, 1)
          this.cacheOrder.push(pass.fragmentShader)
        }
      } else {
        program = this.buildProgram(pass.fragmentShader)
        if (!program) return null
        if (this.cacheOrder.length >= this.MAX_CACHE) {
          const evict = this.cacheOrder.shift()!
          const old = this.programCache.get(evict)
          if (old) gl.deleteProgram(old)
          this.programCache.delete(evict)
        }
        this.programCache.set(pass.fragmentShader, program)
        this.cacheOrder.push(pass.fragmentShader)
      }

      // Bind target: last pass → main FBO, intermediate → ping-pong FBO
      if (isLast) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.pingPongFBOs![i % 2].framebuffer)
      }

      gl.viewport(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
      gl.useProgram(program)

      // Built-in uniforms
      const uTime = gl.getUniformLocation(program, 'u_time')
      if (uTime) gl.uniform1f(uTime, time)
      const uRes = gl.getUniformLocation(program, 'u_resolution')
      if (uRes) gl.uniform2f(uRes, PREVIEW_SIZE, PREVIEW_SIZE)
      const uRefSize = gl.getUniformLocation(program, 'u_ref_size')
      if (uRefSize) gl.uniform1f(uRefSize, REFERENCE_SIZE)
      const uDpr = gl.getUniformLocation(program, 'u_dpr')
      if (uDpr) gl.uniform1f(uDpr, 1.0)
      const uVp = gl.getUniformLocation(program, 'u_viewport')
      if (uVp) gl.uniform2f(uVp, PREVIEW_SIZE, PREVIEW_SIZE)
      const uAnchor = gl.getUniformLocation(program, 'u_anchor')
      if (uAnchor) gl.uniform2f(uAnchor, 0.5, 0.5)

      // User uniforms
      for (const u of pass.uniforms) {
        const loc = gl.getUniformLocation(program, u.name)
        if (!loc) continue
        if (typeof u.value === 'number') gl.uniform1f(loc, u.value)
        else if (u.value.length === 2) gl.uniform2f(loc, u.value[0], u.value[1])
        else if (u.value.length === 3) gl.uniform3f(loc, u.value[0], u.value[1], u.value[2])
        else if (u.value.length === 4) gl.uniform4f(loc, u.value[0], u.value[1], u.value[2], u.value[3])
      }

      // Bind input textures from previous passes
      let texUnit = 0
      for (const [samplerName, sourcePassIdx] of Object.entries(pass.inputTextures)) {
        const sourceFbo = this.pingPongFBOs![sourcePassIdx % 2]
        gl.activeTexture(gl.TEXTURE0 + texUnit)
        gl.bindTexture(gl.TEXTURE_2D, sourceFbo.texture)
        const samplerLoc = gl.getUniformLocation(program, samplerName)
        if (samplerLoc) gl.uniform1i(samplerLoc, texUnit)
        texUnit++
      }

      // Draw
      gl.bindVertexArray(this.vao)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // Clean up texture bindings
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)

    // Read pixels from main FBO (last pass wrote here)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.readPixels(0, 0, PREVIEW_SIZE, PREVIEW_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const imageData = new ImageData(PREVIEW_SIZE, PREVIEW_SIZE)
    for (let y = 0; y < PREVIEW_SIZE; y++) {
      const srcRow = (PREVIEW_SIZE - 1 - y) * PREVIEW_SIZE * 4
      const dstRow = y * PREVIEW_SIZE * 4
      imageData.data.set(this.readBuf.subarray(srcRow, srcRow + PREVIEW_SIZE * 4), dstRow)
    }
    return this.renderToImageBitmap(imageData)
  }

  // Ping-pong FBOs for multi-pass preview (shared, allocated once) [P8]
  private pingPongFBOs: Array<{ framebuffer: WebGLFramebuffer; texture: WebGLTexture }> | null = null

  private ensurePingPongFBOs() {
    if (this.pingPongFBOs) return
    const gl = this.gl
    this.pingPongFBOs = [0, 1].map(() => {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PREVIEW_SIZE, PREVIEW_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindTexture(gl.TEXTURE_2D, null)

      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return { framebuffer: fb, texture: tex }
    })
  }

  dispose() {
    const gl = this.gl
    for (const prog of this.programCache.values()) gl.deleteProgram(prog)
    this.programCache.clear()
    gl.deleteFramebuffer(this.fbo)
    gl.deleteTexture(this.fboTexture)
    if (this.pingPongFBOs) {
      for (const fbo of this.pingPongFBOs) {
        gl.deleteFramebuffer(fbo.framebuffer)
        gl.deleteTexture(fbo.texture)
      }
    }
    gl.deleteShader(this.vertexShader)
  }
}
