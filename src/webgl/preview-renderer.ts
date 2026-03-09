/**
 * Offscreen WebGL2 renderer for per-node preview thumbnails.
 * Uses a single offscreen canvas + FBO to render subgraph shaders
 * and read pixels back as data URLs for <img> display.
 */

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

export interface UniformUpload {
  name: string
  value: number | number[]
}

export class PreviewRenderer {
  private gl: WebGL2RenderingContext
  private vao: WebGLVertexArrayObject
  private fbo: WebGLFramebuffer
  private fboTexture: WebGLTexture
  private vertexShader: WebGLShader
  private programCache = new Map<string, WebGLProgram>()
  private cacheOrder: string[] = []
  private readonly MAX_CACHE = 64
  private readBuf = new Uint8Array(PREVIEW_SIZE * PREVIEW_SIZE * 4)
  private offscreen2d: OffscreenCanvas
  private ctx2d: OffscreenCanvasRenderingContext2D
  private startTime = Date.now()

  constructor() {
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

    // Offscreen 2D canvas for ImageData → data URL conversion
    this.offscreen2d = new OffscreenCanvas(PREVIEW_SIZE, PREVIEW_SIZE)
    this.ctx2d = this.offscreen2d.getContext('2d')!
  }

  /**
   * Render a fragment shader and return a data URL, or null on compile error.
   */
  renderPreview(fragmentShader: string, uniforms: UniformUpload[]): string | null {
    const gl = this.gl

    // Get or compile program
    let program = this.programCache.get(fragmentShader) ?? null
    if (!program) {
      program = this.buildProgram(fragmentShader)
      if (!program) return null
      // LRU cache management
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
    if (uRefSize) gl.uniform1f(uRefSize, PREVIEW_SIZE)

    const uMouse = gl.getUniformLocation(program, 'u_mouse')
    if (uMouse) gl.uniform2f(uMouse, 0, 0)

    const uDpr = gl.getUniformLocation(program, 'u_dpr')
    if (uDpr) gl.uniform1f(uDpr, 1.0)

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

    // Convert to data URL via offscreen 2D canvas
    // WebGL reads bottom-up, so flip vertically
    const imageData = new ImageData(PREVIEW_SIZE, PREVIEW_SIZE)
    for (let y = 0; y < PREVIEW_SIZE; y++) {
      const srcRow = (PREVIEW_SIZE - 1 - y) * PREVIEW_SIZE * 4
      const dstRow = y * PREVIEW_SIZE * 4
      imageData.data.set(this.readBuf.subarray(srcRow, srcRow + PREVIEW_SIZE * 4), dstRow)
    }
    return this.imageDataToDataUrl(imageData)
  }

  private imageDataToDataUrl(imageData: ImageData): string {
    this.ctx2d.putImageData(imageData, 0, 0)
    // OffscreenCanvas doesn't have toDataURL, but we can use a regular canvas
    const c = document.createElement('canvas')
    c.width = PREVIEW_SIZE
    c.height = PREVIEW_SIZE
    const ctx = c.getContext('2d')!
    ctx.putImageData(imageData, 0, 0)
    return c.toDataURL()
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
    } catch {
      return null
    }

    const program = gl.createProgram()!
    gl.attachShader(program, this.vertexShader)
    gl.attachShader(program, fragShader)
    gl.linkProgram(program)
    gl.deleteShader(fragShader)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      return null
    }

    return program
  }

  destroy() {
    const gl = this.gl
    for (const prog of this.programCache.values()) gl.deleteProgram(prog)
    this.programCache.clear()
    gl.deleteFramebuffer(this.fbo)
    gl.deleteTexture(this.fboTexture)
    gl.deleteShader(this.vertexShader)
  }
}
