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

uniform float u_time;
uniform vec2 u_resolution;

void main() {
  vec2 uv = v_uv;
  vec3 color = vec3(
    0.5 + 0.5 * sin(u_time + uv.x * 3.0),
    0.5 + 0.5 * sin(u_time + uv.y * 3.0 + 2.0),
    0.5 + 0.5 * sin(u_time + (uv.x + uv.y) * 3.0 + 4.0)
  );
  fragColor = vec4(color, 1.0);
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      throw new Error('WebGL2 not supported')
    }
    this.gl = gl

    this.initQuad()
    this.updateShader(DEFAULT_FRAGMENT_SHADER)
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

  render() {
    const gl = this.gl
    if (!this.program || !this.vao) return

    // Update canvas size
    const displayWidth = this.canvas.clientWidth
    const displayHeight = this.canvas.clientHeight
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
    const animate = () => {
      this.render()
      this.animationFrameId = requestAnimationFrame(animate)
    }
    animate()
  }

  stopAnimation() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  destroy() {
    this.stopAnimation()
    const gl = this.gl
    if (this.program) {
      gl.deleteProgram(this.program)
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao)
    }
  }
}
