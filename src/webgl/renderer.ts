/**
 * WebGL2 fullscreen quad renderer
 * Renders fragment shaders on a simple 2-triangle quad
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

const DEFAULT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

void main() {
  fragColor = vec4(0.0, 0.0, 0.0, 1.0);
}
`

export class WebGLRenderer {
  private canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private uniforms: Map<string, WebGLUniformLocation> = new Map()
  private startTime: number = Date.now()
  private animationFrameId: number | null = null
  private refSize: number | null = null
  private animated = true
  private renderRequested = false
  private resizeObserver: ResizeObserver | null = null
  private targetFps = 60
  private lastFrameTime = 0
  private readonly ANIMATED_DPR_SCALE = 0.75
  private readonly STATIC_DPR_SCALE = 1.0
  private currentDprScale = 1.0
  private snapTimer: ReturnType<typeof setTimeout> | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      throw new Error('WebGL2 not supported')
    }
    this.gl = gl

    this.initQuad()
    this.updateShader(DEFAULT_FRAGMENT_SHADER)

    this.resizeObserver = new ResizeObserver(() => {
      this.requestRender()
    })
    this.resizeObserver.observe(canvas)
  }

  private initQuad() {
    const gl = this.gl

    // Create VAO
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('Failed to create VAO')
    gl.bindVertexArray(vao)
    this.vao = vao

    // Create quad vertex buffer (2 triangles covering -1 to 1 in clip space)
    const positions = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ])

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    gl.bindVertexArray(null)
  }

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

  updateShader(fragmentSource: string): { success: boolean; error?: string } {
    const gl = this.gl

    try {
      const vertexShader = this.createShader(gl.VERTEX_SHADER, VERTEX_SHADER)
      const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentSource)

      const program = gl.createProgram()
      if (!program) throw new Error('Failed to create program')

      gl.attachShader(program, vertexShader)
      gl.attachShader(program, fragmentShader)
      gl.bindAttribLocation(program, 0, 'a_position')
      gl.linkProgram(program)

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program)
        gl.deleteProgram(program)
        throw new Error('Program linking failed: ' + info)
      }

      // Clean up old program
      if (this.program) {
        gl.deleteProgram(this.program)
      }

      this.program = program
      gl.useProgram(program)

      // Cache uniform locations
      this.uniforms.clear()
      const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)
      for (let i = 0; i < uniformCount; i++) {
        const info = gl.getActiveUniform(program, i)
        if (info) {
          const location = gl.getUniformLocation(program, info.name)
          if (location) {
            this.uniforms.set(info.name, location)
          }
        }
      }

      // Clean up shaders
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)

      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('Failed to update shader:', errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  updateUniforms(uniforms: Array<{ name: string; value: number | number[] }>) {
    const gl = this.gl
    if (!this.program || gl.isContextLost()) return
    gl.useProgram(this.program)

    for (const { name, value } of uniforms) {
      const loc = this.uniforms.get(name)
      if (!loc) continue

      if (typeof value === 'number') {
        gl.uniform1f(loc, value)
      } else if (Array.isArray(value)) {
        if (value.length === 2) gl.uniform2f(loc, value[0], value[1])
        else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2])
        else if (value.length === 4) gl.uniform4f(loc, value[0], value[1], value[2], value[3])
      }
    }

    this.requestRender()
  }

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
    if (speed < 0.05) this.targetFps = 30
    else if (speed < 0.15) this.targetFps = 45
    else this.targetFps = 60
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
        this.render()
        this.currentDprScale = this.ANIMATED_DPR_SCALE
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

  render() {
    const gl = this.gl
    if (!this.program || !this.vao) return
    if (gl.isContextLost()) return

    // Update canvas size (account for device pixel ratio, scaled for animation)
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const displayWidth = Math.floor(this.canvas.clientWidth * dpr)
    const displayHeight = Math.floor(this.canvas.clientHeight * dpr)
    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth
      this.canvas.height = displayHeight
      gl.viewport(0, 0, displayWidth, displayHeight)
    }

    gl.useProgram(this.program)

    // Update uniforms
    const time = (Date.now() - this.startTime) / 1000
    const timeLocation = this.uniforms.get('u_time')
    if (timeLocation) {
      gl.uniform1f(timeLocation, time)
    }

    const resolutionLocation = this.uniforms.get('u_resolution')
    if (resolutionLocation) {
      gl.uniform2f(resolutionLocation, displayWidth, displayHeight)
    }

    const dprLocation = this.uniforms.get('u_dpr')
    if (dprLocation) {
      gl.uniform1f(dprLocation, dpr)
    }

    // Freeze reference size on first valid render
    if (this.refSize === null && displayWidth > 0 && displayHeight > 0) {
      this.refSize = Math.min(displayWidth, displayHeight)
    }
    const refSizeLocation = this.uniforms.get('u_ref_size')
    if (refSizeLocation && this.refSize !== null) {
      gl.uniform1f(refSizeLocation, this.refSize)
    }

    // Draw
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

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

  destroy() {
    this.stopAnimation()
    if (this.snapTimer) { clearTimeout(this.snapTimer); this.snapTimer = null }
    this.resizeObserver?.disconnect()
    const gl = this.gl
    if (this.program) {
      gl.deleteProgram(this.program)
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao)
    }
  }
}
