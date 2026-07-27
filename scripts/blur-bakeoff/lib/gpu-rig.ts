// GPU capture rig: renders multi-pass fragment shaders to a full-size offscreen
// target in headless Chrome and reads the pixels back. The repo has no full-res
// readback path (only the 80x80 preview thumbnail), so the bake-off needs one.
//
// The rig deliberately reproduces the characteristics that decide blur quality:
//   - rgba8unorm intermediates by default (the engine's real precision), with an
//     opt-in float16 intermediate for the Phase 2 precision experiment
//   - linear/nearest clamp-to-edge sampling, matching the engine's samplers
//   - highp / f32 fragment math
//   - opt-in per-pass resolution scale, prototyping the downsample pyramid the
//     engine cannot express today
//
// Shader contract (identical on both backends, so parity is structural):
//   body must `return` a vec4. Available:
//     uv                  current fragment UV, (0,0) = TOP-left, y down
//     U.u_resolution      this pass's target size in px
//     U.u_texel           1/source size (tap offset unit)
//     U.u_direction       direction vector (motion blur)
//     U.u_center          center point (radial blur)
//     U.u_params          spare vec4
//     U.u_radius          blur radius in px
//     sampleSrc(uv)       previous pass output (or the input image on pass 0)
//     sampleOrig(uv)      always the original input image
//   WGSL gets `alias vec2/vec3/vec4/float` so the same body text compiles on both.
//
// Orientation: captured output is always top-row-first, and an uploaded image is
// interpreted top-row-first. WebGPU needs a flipped UV mapping to achieve that,
// WebGL2 the standard one; both are verified by a byte-exact passthrough test.

import { chromium, type Browser, type Page } from 'playwright-core'
import http from 'node:http'
import type { Rgba8 } from './image'

export type Backend = 'webgpu' | 'webgl2'

export interface PassSpec {
  /** Fragment body; must `return` a vec4. */
  body: string
  /** Optional helper declarations emitted before the entry function. */
  prelude?: string
  /** Output resolution scale for this pass (1 = full). Prototypes pyramids. */
  scale?: number
  /** How this pass samples its source. */
  filter?: 'linear' | 'nearest'
  /** Use an rgba16float intermediate target instead of rgba8unorm. */
  float16?: boolean
}

export interface CaptureSpec {
  backend: Backend
  width: number
  height: number
  passes: PassSpec[]
  input?: Rgba8
  radius?: number
  direction?: [number, number]
  center?: [number, number]
  params?: [number, number, number, number]
}

export interface Rig {
  available: { webgpu: boolean; webgl2: boolean }
  capture(spec: CaptureSpec): Promise<Rgba8>
  /** Decode an arbitrary image file (JPEG/PNG/WebP) to Rgba8 using Chrome's decoders. */
  decodeImage(bytes: Uint8Array, mime: string, maxSize?: number): Promise<Rgba8>
  close(): Promise<void>
}

const UNIFORM_BYTES = 64

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export async function createRig(): Promise<Rig> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>blur-rig</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  })
  const page: Page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.addScriptTag({ content: BROWSER_SIDE })

  const available = await page.evaluate(async () => {
    return await (window as unknown as { __rig: { probe(): Promise<{ webgpu: boolean; webgl2: boolean }> } }).__rig.probe()
  })

  return {
    available,
    async capture(spec: CaptureSpec): Promise<Rgba8> {
      const payload = {
        backend: spec.backend,
        width: spec.width,
        height: spec.height,
        passes: spec.passes,
        radius: spec.radius ?? 0,
        direction: spec.direction ?? [1, 0],
        center: spec.center ?? [0.5, 0.5],
        params: spec.params ?? [0, 0, 0, 0],
        input: spec.input
          ? { width: spec.input.width, height: spec.input.height, b64: toBase64(new Uint8Array(spec.input.data.buffer, spec.input.data.byteOffset, spec.input.data.length)) }
          : null,
      }
      const res = await page.evaluate(
        async (p) => await (window as unknown as { __rig: { capture(p: unknown): Promise<{ ok: boolean; error?: string; width: number; height: number; b64: string }> } }).__rig.capture(p),
        payload,
      )
      if (!res.ok) throw new Error(`capture failed: ${res.error}`)
      const raw = Buffer.from(res.b64, 'base64')
      return { width: res.width, height: res.height, data: new Uint8ClampedArray(raw) }
    },
    async decodeImage(bytes: Uint8Array, mime: string, maxSize?: number): Promise<Rgba8> {
      const res = await page.evaluate(
        async (p) => await (window as unknown as { __rig: { decode(p: unknown): Promise<{ ok: boolean; error?: string; width: number; height: number; b64: string }> } }).__rig.decode(p),
        { b64: toBase64(bytes), mime, maxSize: maxSize ?? 0 },
      )
      if (!res.ok) throw new Error(`decode failed: ${res.error}`)
      const raw = Buffer.from(res.b64, 'base64')
      return { width: res.width, height: res.height, data: new Uint8ClampedArray(raw) }
    },
    async close() {
      await browser.close()
      server.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Browser-side implementation (plain JS, runs in the page).
// ---------------------------------------------------------------------------
const BROWSER_SIDE = /* js */ `
(() => {
  const UNIFORM_BYTES = ${UNIFORM_BYTES};

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  // Uniform buffer layout, shared by both backends (std140-compatible):
  //   0  u_resolution vec2 | 8  u_texel vec2 | 16 u_direction vec2
  //   24 u_center vec2     | 32 u_params vec4 | 48 u_radius f32 | pad to 64
  function packUniforms(resW, resH, texelX, texelY, dir, center, params, radius) {
    const buf = new ArrayBuffer(UNIFORM_BYTES);
    const f = new Float32Array(buf);
    f[0] = resW;  f[1] = resH;
    f[2] = texelX; f[3] = texelY;
    f[4] = dir[0]; f[5] = dir[1];
    f[6] = center[0]; f[7] = center[1];
    f[8] = params[0]; f[9] = params[1]; f[10] = params[2]; f[11] = params[3];
    f[12] = radius;
    return buf;
  }

  const WGSL_PREAMBLE = \`
alias float = f32;
alias vec2 = vec2f;
alias vec3 = vec3f;
alias vec4 = vec4f;

struct Uniforms {
  u_resolution: vec2f,
  u_texel: vec2f,
  u_direction: vec2f,
  u_center: vec2f,
  u_params: vec4f,
  u_radius: f32,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var srcSamp: sampler;
@group(0) @binding(3) var origTex: texture_2d<f32>;
@group(0) @binding(4) var origSamp: sampler;

fn sampleSrc(p: vec2f) -> vec4f { return textureSample(srcTex, srcSamp, p); }
fn sampleOrig(p: vec2f) -> vec4f { return textureSample(origTex, origSamp, p); }

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_uv: vec2f,
};

// Flipped V so that target row 0 (clip y=+1) corresponds to uv.y=0 (image top),
// which keeps pass->pass sampling and the final readback all top-row-first.
@vertex fn vs_main(@location(0) a_position: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.v_uv = vec2f(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  out.position = vec4f(a_position, 0.0, 1.0);
  return out;
}
\`;

  function wgslModule(body, prelude) {
    return WGSL_PREAMBLE + (prelude || '') + \`
fn sombraMain(uv: vec2f) -> vec4f {
\` + body + \`
}

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return sombraMain(in.v_uv);
}
\`;
  }

  const GLSL_VERT = \`#version 300 es
precision highp float;
in vec2 a_position;
out vec2 v_uv;
void main() {
  // Standard mapping: FBO row 0 (clip y=-1) <- uv.y=0. Combined with an
  // unflipped readPixels this yields top-row-first output.
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
\`;

  function glslFrag(body, prelude) {
    return \`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

layout(std140) uniform Uniforms {
  vec2 u_resolution;
  vec2 u_texel;
  vec2 u_direction;
  vec2 u_center;
  vec4 u_params;
  float u_radius;
} U;

uniform sampler2D u_src;
uniform sampler2D u_orig;

vec4 sampleSrc(vec2 p) { return texture(u_src, p); }
vec4 sampleOrig(vec2 p) { return texture(u_orig, p); }
\` + (prelude || '') + \`
vec4 sombraMain(vec2 uv) {
\` + body + \`
}

void main() { fragColor = sombraMain(v_uv); }
\`;
  }

  const QUAD = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);

  // ---- WebGPU ------------------------------------------------------------
  let gpuDevice = null;
  async function getDevice() {
    if (gpuDevice) return gpuDevice;
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    gpuDevice = await adapter.requestDevice();
    return gpuDevice;
  }

  async function captureWebGPU(spec) {
    const device = await getDevice();
    if (!device) throw new Error('WebGPU unavailable');
    // Validation errors in WebGPU do not throw; they invalidate the object and the
    // draw is dropped, yielding a plausible-looking black image. For a measurement
    // harness that is the worst failure mode, so capture the scope and surface it.
    device.pushErrorScope('validation');
    try {
      const r = await captureWebGPUInner(spec, device);
      const err = await device.popErrorScope();
      if (err) throw new Error('WebGPU validation: ' + err.message);
      return r;
    } catch (e) {
      // pop the scope even on throw so it does not leak into the next capture
      try { await device.popErrorScope(); } catch (_) {}
      throw e;
    }
  }

  async function captureWebGPUInner(spec, device) {
    const W = spec.width, H = spec.height;

    const quadBuf = device.createBuffer({ size: QUAD.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(quadBuf, 0, QUAD);

    // original input texture
    const inW = spec.input ? spec.input.width : 1;
    const inH = spec.input ? spec.input.height : 1;
    const origTex = device.createTexture({
      size: [inW, inH], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (spec.input) {
      const bytes = b64ToBytes(spec.input.b64);
      device.queue.writeTexture({ texture: origTex }, bytes, { bytesPerRow: inW * 4, rowsPerImage: inH }, [inW, inH]);
    } else {
      device.queue.writeTexture({ texture: origTex }, new Uint8Array([0,0,0,255]), { bytesPerRow: 4, rowsPerImage: 1 }, [1,1]);
    }

    const samplers = {
      linear: device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
      nearest: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
    };

    // Explicit layout, NOT layout:'auto'. An auto layout only contains the
    // bindings a given shader happens to use, so binding all five entries would
    // be a validation error and the draw would be silently dropped (black output).
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

    let srcTex = origTex;
    let srcW = inW, srcH = inH;
    let finalTex = null, finalW = W, finalH = H;

    const encoder = device.createCommandEncoder();
    const toDestroy = [];

    for (let i = 0; i < spec.passes.length; i++) {
      const pass = spec.passes[i];
      const isLast = i === spec.passes.length - 1;
      const scale = pass.scale != null ? pass.scale : 1;
      const tw = Math.max(1, Math.round(W * scale));
      const th = Math.max(1, Math.round(H * scale));
      // Final pass always 8-bit (that is what a display/readback sees).
      const format = (!isLast && pass.float16) ? 'rgba16float' : 'rgba8unorm';

      const target = device.createTexture({
        size: [tw, th], format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });

      const module = device.createShaderModule({ code: wgslModule(pass.body, pass.prelude) });
      const info = await module.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error');
      if (errs.length) throw new Error('WGSL: ' + errs.map(m => 'L' + m.lineNum + ' ' + m.message).join(' | '));

      const pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });

      const ubo = device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ubo, 0, packUniforms(tw, th, 1 / srcW, 1 / srcH, spec.direction, spec.center, spec.params, spec.radius));

      const samp = samplers[pass.filter === 'nearest' ? 'nearest' : 'linear'];
      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: srcTex.createView() },
          { binding: 2, resource: samp },
          { binding: 3, resource: origTex.createView() },
          { binding: 4, resource: samplers.nearest },
        ],
      });

      const rp = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      });
      rp.setPipeline(pipeline);
      rp.setVertexBuffer(0, quadBuf);
      rp.setBindGroup(0, bindGroup);
      rp.draw(6);
      rp.end();

      if (srcTex !== origTex) toDestroy.push(srcTex);
      srcTex = target; srcW = tw; srcH = th;
      finalTex = target; finalW = tw; finalH = th;
    }

    // readback with 256-byte row alignment
    const bytesPerRow = Math.ceil(finalW * 4 / 256) * 256;
    const staging = device.createBuffer({ size: bytesPerRow * finalH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: finalTex }, { buffer: staging, bytesPerRow, rowsPerImage: finalH }, [finalW, finalH]);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange());
    const out = new Uint8Array(finalW * finalH * 4);
    for (let y = 0; y < finalH; y++) {
      out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + finalW * 4), y * finalW * 4);
    }
    staging.unmap();
    staging.destroy();
    origTex.destroy();
    for (const t of toDestroy) t.destroy();
    if (finalTex) finalTex.destroy();

    return { width: finalW, height: finalH, bytes: out };
  }

  // ---- WebGL2 ------------------------------------------------------------
  let glCtx = null;
  function getGL() {
    if (glCtx) return glCtx;
    const c = document.createElement('canvas');
    glCtx = c.getContext('webgl2', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    return glCtx;
  }

  function compileProgram(gl, fragSrc) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, GLSL_VERT); gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error('GLSL vert: ' + gl.getShaderInfoLog(vs));
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error('GLSL frag: ' + gl.getShaderInfoLog(fs));
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('GLSL link: ' + gl.getProgramInfoLog(p));
    gl.deleteShader(vs); gl.deleteShader(fs);
    return p;
  }

  function makeTex(gl, w, h, float16, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (float16) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data || null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  async function captureWebGL(spec) {
    const gl = getGL();
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) { /* float16 targets may fail; report at use */ }
    const W = spec.width, H = spec.height;

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

    const inW = spec.input ? spec.input.width : 1;
    const inH = spec.input ? spec.input.height : 1;
    const inData = spec.input ? b64ToBytes(spec.input.b64) : new Uint8Array([0,0,0,255]);
    const origTex = makeTex(gl, inW, inH, false, inData);

    const ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, UNIFORM_BYTES, gl.DYNAMIC_DRAW);

    let srcTex = origTex, srcW = inW, srcH = inH;
    let outW = W, outH = H;
    const fbo = gl.createFramebuffer();
    const created = [];

    for (let i = 0; i < spec.passes.length; i++) {
      const pass = spec.passes[i];
      const isLast = i === spec.passes.length - 1;
      const scale = pass.scale != null ? pass.scale : 1;
      const tw = Math.max(1, Math.round(W * scale));
      const th = Math.max(1, Math.round(H * scale));
      const useF16 = !isLast && !!pass.float16;

      const target = makeTex(gl, tw, th, useF16, null);
      created.push(target);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: 0x' + fbStatus.toString(16));

      const prog = compileProgram(gl, glslFrag(pass.body, pass.prelude));
      gl.useProgram(prog);

      // uniform block
      const blockIdx = gl.getUniformBlockIndex(prog, 'Uniforms');
      if (blockIdx !== gl.INVALID_INDEX) {
        gl.uniformBlockBinding(prog, blockIdx, 0);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
      }
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, new Float32Array(packUniforms(tw, th, 1/srcW, 1/srcH, spec.direction, spec.center, spec.params, spec.radius)));

      // textures
      const filt = pass.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_src'), 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, origTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(gl.getUniformLocation(prog, 'u_orig'), 1);

      const loc = gl.getAttribLocation(prog, 'a_position');
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      gl.viewport(0, 0, tw, th);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.deleteProgram(prog);

      srcTex = target; srcW = tw; srcH = th;
      outW = tw; outH = th;
    }

    const px = new Uint8Array(outW * outH * 4);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error('GL error 0x' + err.toString(16));

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(origTex);
    for (const t of created) gl.deleteTexture(t);
    gl.deleteBuffer(vbo);
    gl.deleteBuffer(ubo);

    return { width: outW, height: outH, bytes: px };
  }

  window.__rig = {
    async probe() {
      let webgpu = false;
      try { webgpu = !!(await getDevice()); } catch (e) { webgpu = false; }
      let webgl2 = false;
      try { webgl2 = !!getGL(); } catch (e) { webgl2 = false; }
      return { webgpu, webgl2 };
    },
    async capture(spec) {
      try {
        const r = spec.backend === 'webgpu' ? await captureWebGPU(spec) : await captureWebGL(spec);
        return { ok: true, width: r.width, height: r.height, b64: bytesToB64(r.bytes) };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e), width: 0, height: 0, b64: '' };
      }
    },
    async decode(p) {
      try {
        const bytes = b64ToBytes(p.b64);
        const blob = new Blob([bytes], { type: p.mime });
        let bmp = await createImageBitmap(blob);
        let w = bmp.width, h = bmp.height;
        if (p.maxSize && Math.max(w, h) > p.maxSize) {
          const s = p.maxSize / Math.max(w, h);
          const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
          bmp = await createImageBitmap(blob, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' });
          w = nw; h = nh;
        }
        const cvs = new OffscreenCanvas(w, h);
        const ctx = cvs.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const id = ctx.getImageData(0, 0, w, h);
        return { ok: true, width: w, height: h, b64: bytesToB64(new Uint8Array(id.data.buffer)) };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e), width: 0, height: 0, b64: '' };
      }
    },
  };
})();
`
