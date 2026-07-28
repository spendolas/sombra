/**
 * Phase 10b rig — run Sombra's OWN emitted shaders, verbatim or source-rewritten,
 * on a real GPU, on BOTH backends.
 *
 * Why a new file rather than reuse:
 *   - `lib/gpu-rig.ts#captureRawGlsl` is WebGL2-only, chains passes by position,
 *     uploads images unflipped and returns bottom-row-first — so its output is
 *     not comparable pixel-for-pixel with the WebGPU path.
 *   - `phase10-rig.ts` is WebGPU-only and has no timing.
 * The AA bake-off has to score the same candidate on both backends against one
 * ground truth, so it needs one executor with one orientation contract and one
 * uniform-binding contract. Both halves are gated by a byte-exact bypass control
 * and a cross-backend agreement control in `phase10-reed-aa.ts --validate`.
 *
 * Contract (identical on both backends):
 *   - output is TOP-row-first, like `Rgba8` everywhere else in the bake-off
 *   - an uploaded image is interpreted TOP-row-first
 *   - intermediates are rgba8unorm, linear filtered, clamp-to-edge, no mips,
 *     no MSAA — exactly what `src/webgpu/renderer.ts` and `src/webgl/renderer.ts`
 *     allocate for a `textureInput` pass boundary
 *   - built-in uniforms match the renderers:
 *       u_resolution = u_viewport = drawing-buffer size in DEVICE px
 *       u_ref_size   = 512 (REFERENCE_SIZE), u_dpr = the capped/scaled dpr
 *
 * Timing: WebGPU uses `timestamp-query` when the adapter exposes it; WebGL2 uses
 * wall-clock around a forced-sync repeat loop. Both are reported with the method
 * named so a reader can discount the weaker one.
 */

import { chromium, type Browser, type Page } from 'playwright-core'
import http from 'node:http'
import type { Rgba8 } from './lib/image'

export type Backend = 'webgpu' | 'webgl2'

/** One pass, in whichever language the backend speaks. */
export interface AaPass {
  /** WGSL module source (WebGPU) */
  wgsl: string
  /** GLSL ES 3.00 fragment source (WebGL2) */
  glslFrag: string
  /** GLSL ES 3.00 vertex source (WebGL2) */
  glslVert: string
  /** uniform name -> byte offset, from WGSLPassOutput.uniformLayout.offsets */
  uniformOffsets: Record<string, number>
  uniformTotalSize: number
  /** WGSL texture/sampler bindings for group 1 */
  textureBindings: Array<{ samplerName: string; textureBinding: number; samplerBinding: number; group: number }>
  /** samplerName -> index of the pass whose output it reads */
  inputTextures: Array<{ passIndex: number; samplerName: string }>
  /** the pass's own user uniforms at their compile-time values */
  userUniforms: Array<{ name: string; glslType: string; value: number | number[] }>
  filter?: 'linear' | 'nearest'
}

export interface AaRunSpec {
  backend: Backend
  width: number
  height: number
  /** value written to u_dpr */
  dpr?: number
  time?: number
  anchor?: [number, number]
  passes: AaPass[]
  /** samplerName -> image for image-node textures (top-row-first; the rig flips) */
  images?: Record<string, Rgba8>
  /** repeat the final pass N times and time it (0 = no timing) */
  timeRepeats?: number
}

export interface AaRunResult {
  image: Rgba8
  /** nanoseconds per final-pass draw, or null when unavailable */
  gpuNs: number | null
  timingMethod: 'timestamp-query' | 'wall-clock' | 'none'
}

export interface AaRig {
  adapterInfo: string
  available: { webgpu: boolean; webgl2: boolean }
  hasTimestamp: boolean
  run(spec: AaRunSpec): Promise<AaRunResult>
  decodeImage(bytes: Uint8Array, mime: string, maxSize?: number): Promise<Rgba8>
  close(): Promise<void>
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Flip rows: Rgba8 is top-first, both backends want v=0 at the image bottom. */
function flipRows(img: Rgba8): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4)
  const stride = img.width * 4
  for (let y = 0; y < img.height; y++) {
    const src = (img.height - 1 - y) * stride
    out.set(img.data.subarray(src, src + stride), y * stride)
  }
  return out
}

export async function createAaRig(): Promise<AaRig> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>phase10-aa-rig</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  })
  const page: Page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()) })
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.addScriptTag({ content: BROWSER_SIDE })

  const probe = await page.evaluate(async () =>
    await (window as unknown as { __p10aa: { probe(): Promise<{ webgpu: boolean; webgl2: boolean; info: string; timestamp: boolean }> } }).__p10aa.probe())

  return {
    adapterInfo: probe.info,
    available: { webgpu: probe.webgpu, webgl2: probe.webgl2 },
    hasTimestamp: probe.timestamp,

    async run(spec: AaRunSpec): Promise<AaRunResult> {
      const images: Record<string, { width: number; height: number; b64: string }> = {}
      for (const [k, v] of Object.entries(spec.images ?? {})) {
        images[k] = { width: v.width, height: v.height, b64: toBase64(flipRows(v)) }
      }
      const payload = {
        backend: spec.backend,
        width: spec.width,
        height: spec.height,
        dpr: spec.dpr ?? 1,
        time: spec.time ?? 0,
        anchor: spec.anchor ?? [0.5, 0.5],
        timeRepeats: spec.timeRepeats ?? 0,
        passes: spec.passes,
        images,
      }
      const res = await page.evaluate(
        async (p) => await (window as unknown as {
          __p10aa: { run(p: unknown): Promise<{ ok: boolean; error?: string; width: number; height: number; b64: string; gpuNs: number | null; timingMethod: string }> }
        }).__p10aa.run(p),
        payload,
      )
      if (!res.ok) throw new Error(`phase10-aa ${spec.backend} run failed: ${res.error}`)
      const raw = Buffer.from(res.b64, 'base64')
      return {
        image: { width: res.width, height: res.height, data: new Uint8ClampedArray(raw) },
        gpuNs: res.gpuNs,
        timingMethod: res.timingMethod as AaRunResult['timingMethod'],
      }
    },

    async decodeImage(bytes: Uint8Array, mime: string, maxSize?: number): Promise<Rgba8> {
      const res = await page.evaluate(
        async (p) => await (window as unknown as { __p10aa: { decode(p: unknown): Promise<{ ok: boolean; error?: string; width: number; height: number; b64: string }> } }).__p10aa.decode(p),
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

const BROWSER_SIDE = /* js */ `
(() => {
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }

  const QUAD = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);

  // ---- WebGPU -------------------------------------------------------------
  let device = null, hasTs = false;
  async function getDevice() {
    if (device) return device;
    if (!navigator.gpu) throw new Error('no navigator.gpu');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    hasTs = adapter.features && adapter.features.has('timestamp-query');
    device = await adapter.requestDevice(hasTs ? { requiredFeatures: ['timestamp-query'] } : {});
    return device;
  }

  function fillUniforms(spec, pass, W, H) {
    const size = Math.max(16, pass.uniformTotalSize);
    const f32 = new Float32Array(size / 4);
    const off = pass.uniformOffsets;
    const set = (name, vals) => {
      if (!(name in off)) return;
      const base = off[name] / 4;
      for (let k = 0; k < vals.length; k++) f32[base + k] = vals[k];
    };
    set('u_time', [spec.time]);
    set('u_resolution', [W, H]);
    set('u_dpr', [spec.dpr]);
    set('u_ref_size', [512]);
    set('u_viewport', [W, H]);
    set('u_anchor', spec.anchor);
    set('u_mouse', [0, 0]);
    for (const u of pass.userUniforms) set(u.name, Array.isArray(u.value) ? u.value : [u.value]);
    return { f32, size };
  }

  async function runWebgpu(spec) {
    const dev = await getDevice();
    const W = spec.width, H = spec.height;
    const R = spec.timeRepeats | 0;
    const useTs = hasTs && R > 0;

    const quadBuf = dev.createBuffer({ size: QUAD.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(quadBuf, 0, QUAD);

    const linear = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const nearest = dev.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const imageTex = {};
    for (const name of Object.keys(spec.images || {})) {
      const im = spec.images[name];
      const t = dev.createTexture({ size: [im.width, im.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      dev.queue.writeTexture({ texture: t }, b64ToBytes(im.b64), { bytesPerRow: im.width * 4, rowsPerImage: im.height }, [im.width, im.height]);
      imageTex[name] = t;
    }

    const passTextures = [];
    const encoder = dev.createCommandEncoder();

    // timestamps around the final pass only
    let qs = null, qbuf = null, qread = null;
    const nQueries = useTs ? 2 : 0;
    if (useTs) {
      qs = dev.createQuerySet({ type: 'timestamp', count: nQueries });
      qbuf = dev.createBuffer({ size: nQueries * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      qread = dev.createBuffer({ size: nQueries * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }

    for (let i = 0; i < spec.passes.length; i++) {
      const pass = spec.passes[i];
      const isLast = i === spec.passes.length - 1;
      const target = dev.createTexture({ size: [W, H], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });

      const module = dev.createShaderModule({ code: pass.wgsl });
      const info = await module.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error');
      if (errs.length) throw new Error('pass ' + i + ' WGSL: ' + errs.map(m => 'L' + m.lineNum + ':' + m.linePos + ' ' + m.message).join(' | '));

      const g0layout = dev.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      });
      const layouts = [g0layout];
      let g1layout = null;
      if (pass.textureBindings.length > 0) {
        const entries = [];
        for (const tb of pass.textureBindings) {
          entries.push({ binding: tb.textureBinding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
          entries.push({ binding: tb.samplerBinding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } });
        }
        g1layout = dev.createBindGroupLayout({ entries });
        layouts.push(g1layout);
      }

      const pipeline = dev.createRenderPipeline({
        layout: dev.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module, entryPoint: 'vs_main', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });

      const uf = fillUniforms(spec, pass, W, H);
      const ubo = dev.createBuffer({ size: uf.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ubo, 0, uf.f32);

      const bindGroups = [dev.createBindGroup({ layout: g0layout, entries: [{ binding: 0, resource: { buffer: ubo } }] })];
      if (g1layout) {
        const samp = pass.filter === 'nearest' ? nearest : linear;
        const inputMap = {};
        for (const it of pass.inputTextures) inputMap[it.samplerName] = it.passIndex;
        const entries = [];
        for (const tb of pass.textureBindings) {
          let tex = null;
          if (tb.samplerName in inputMap) {
            tex = passTextures[inputMap[tb.samplerName]];
            if (!tex) throw new Error('pass ' + i + ': missing source pass');
          } else if (imageTex[tb.samplerName]) {
            tex = imageTex[tb.samplerName];
          } else {
            throw new Error('pass ' + i + ': no texture bound for ' + tb.samplerName);
          }
          entries.push({ binding: tb.textureBinding, resource: tex.createView() });
          entries.push({ binding: tb.samplerBinding, resource: samp });
        }
        bindGroups.push(dev.createBindGroup({ layout: g1layout, entries }));
      }

      const desc = {
        colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      };
      if (useTs && isLast) desc.timestampWrites = { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };

      const rp = encoder.beginRenderPass(desc);
      rp.setPipeline(pipeline);
      rp.setVertexBuffer(0, quadBuf);
      for (let g = 0; g < bindGroups.length; g++) rp.setBindGroup(g, bindGroups[g]);
      const reps = (isLast && R > 0) ? R : 1;
      for (let k = 0; k < reps; k++) rp.draw(6);
      rp.end();

      passTextures.push(target);
    }

    if (useTs) encoder.resolveQuerySet(qs, 0, nQueries, qbuf, 0);

    const finalTex = passTextures[passTextures.length - 1];
    const bytesPerRow = Math.ceil(W * 4 / 256) * 256;
    const staging = dev.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: finalTex }, { buffer: staging, bytesPerRow, rowsPerImage: H }, [W, H]);
    if (useTs) encoder.copyBufferToBuffer(qbuf, 0, qread, 0, nQueries * 8);
    dev.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange());
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + W * 4), y * W * 4);
    staging.unmap(); staging.destroy();

    let gpuNs = null, method = 'none';
    if (useTs) {
      await qread.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(qread.getMappedRange().slice(0));
      qread.unmap();
      const delta = Number(t[1] - t[0]);
      if (delta > 0) { gpuNs = delta / R; method = 'timestamp-query'; }
      qread.destroy(); qbuf.destroy(); qs.destroy();
    }

    for (const t of passTextures) t.destroy();
    for (const k of Object.keys(imageTex)) imageTex[k].destroy();
    return { width: W, height: H, bytes: out, gpuNs: gpuNs, timingMethod: method };
  }

  // ---- WebGL2 -------------------------------------------------------------
  let gl = null;
  function getGL() {
    if (gl) return gl;
    const cvs = new OffscreenCanvas(4, 4);
    gl = cvs.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    return gl;
  }
  function makeTex(g, w, h, data) {
    const t = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, t);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, data);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    return t;
  }

  function runWebgl2(spec) {
    const g = getGL();
    if (!g) throw new Error('WebGL2 unavailable');
    const W = spec.width, H = spec.height;
    const R = spec.timeRepeats | 0;

    const vbo = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.bufferData(g.ARRAY_BUFFER, QUAD, g.STATIC_DRAW);

    const imageTex = {};
    const created = [];
    for (const name of Object.keys(spec.images || {})) {
      const im = spec.images[name];
      const t = makeTex(g, im.width, im.height, b64ToBytes(im.b64));
      imageTex[name] = t; created.push(t);
    }

    const passTex = [];
    const fbo = g.createFramebuffer();
    let lastMs = null;

    for (let i = 0; i < spec.passes.length; i++) {
      const pass = spec.passes[i];
      const isLast = i === spec.passes.length - 1;
      const target = makeTex(g, W, H, null);
      created.push(target);
      g.bindFramebuffer(g.FRAMEBUFFER, fbo);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, target, 0);
      const st = g.checkFramebufferStatus(g.FRAMEBUFFER);
      if (st !== g.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: 0x' + st.toString(16));

      const vs = g.createShader(g.VERTEX_SHADER);
      g.shaderSource(vs, pass.glslVert); g.compileShader(vs);
      if (!g.getShaderParameter(vs, g.COMPILE_STATUS)) throw new Error('pass ' + i + ' vert: ' + g.getShaderInfoLog(vs));
      const fs = g.createShader(g.FRAGMENT_SHADER);
      g.shaderSource(fs, pass.glslFrag); g.compileShader(fs);
      if (!g.getShaderParameter(fs, g.COMPILE_STATUS)) throw new Error('pass ' + i + ' frag: ' + g.getShaderInfoLog(fs));
      const prog = g.createProgram();
      g.attachShader(prog, vs); g.attachShader(prog, fs); g.linkProgram(prog);
      if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error('pass ' + i + ' link: ' + g.getProgramInfoLog(prog));
      g.deleteShader(vs); g.deleteShader(fs);
      g.useProgram(prog);

      const setF = (n, v) => { const l = g.getUniformLocation(prog, n); if (l) g.uniform1f(l, v); };
      const set2 = (n, a, b) => { const l = g.getUniformLocation(prog, n); if (l) g.uniform2f(l, a, b); };
      setF('u_time', spec.time);
      setF('u_dpr', spec.dpr);
      setF('u_ref_size', 512);
      set2('u_resolution', W, H);
      set2('u_viewport', W, H);
      set2('u_mouse', 0, 0);
      set2('u_anchor', spec.anchor[0], spec.anchor[1]);
      for (const u of pass.userUniforms) {
        const l = g.getUniformLocation(prog, u.name);
        if (!l) continue;
        const v = u.value;
        if (u.glslType === 'float') g.uniform1f(l, Array.isArray(v) ? v[0] : v);
        else if (u.glslType === 'vec2') g.uniform2fv(l, v);
        else if (u.glslType === 'vec3') g.uniform3fv(l, v);
        else g.uniform4fv(l, v);
      }

      const inputMap = {};
      for (const it of pass.inputTextures) inputMap[it.samplerName] = it.passIndex;
      let unit = 0;
      for (const tb of pass.textureBindings) {
        const loc = g.getUniformLocation(prog, tb.samplerName);
        if (!loc) continue;   // sampler unused by this shader (e.g. the seam probe)
        let tex = null;
        if (tb.samplerName in inputMap) tex = passTex[inputMap[tb.samplerName]];
        else if (imageTex[tb.samplerName]) tex = imageTex[tb.samplerName];
        if (!tex) throw new Error('pass ' + i + ': no texture for ' + tb.samplerName);
        g.activeTexture(g.TEXTURE0 + unit);
        g.bindTexture(g.TEXTURE_2D, tex);
        const f = pass.filter === 'nearest' ? g.NEAREST : g.LINEAR;
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, f);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, f);
        g.uniform1i(loc, unit);
        unit++;
      }

      const loc = g.getAttribLocation(prog, 'a_position');
      if (loc < 0) throw new Error('pass ' + i + ': a_position not found');
      g.bindBuffer(g.ARRAY_BUFFER, vbo);
      g.enableVertexAttribArray(loc);
      g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);

      g.viewport(0, 0, W, H);
      g.disable(g.BLEND);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.drawArrays(g.TRIANGLES, 0, 6);
      const de = g.getError();
      if (de !== g.NO_ERROR) throw new Error('pass ' + i + ' draw error 0x' + de.toString(16));

      if (isLast && R > 0) {
        const sync1 = new Uint8Array(4);
        g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, sync1);  // flush the warm-up
        const t0 = performance.now();
        for (let k = 0; k < R; k++) g.drawArrays(g.TRIANGLES, 0, 6);
        g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, sync1);  // force completion
        lastMs = (performance.now() - t0) / R;
      }

      g.deleteProgram(prog);
      passTex.push(target);
    }

    const px = new Uint8Array(W * H * 4);
    g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
    const err = g.getError();
    if (err !== g.NO_ERROR) throw new Error('GL error 0x' + err.toString(16));
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.deleteFramebuffer(fbo);
    for (const t of created) g.deleteTexture(t);
    g.deleteBuffer(vbo);

    // readPixels gives bottom-row-first; the rig contract is top-row-first.
    const out = new Uint8Array(W * H * 4);
    const stride = W * 4;
    for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * stride, (H - y) * stride), y * stride);

    return { width: W, height: H, bytes: out, gpuNs: lastMs === null ? null : lastMs * 1e6, timingMethod: lastMs === null ? 'none' : 'wall-clock' };
  }

  window.__p10aa = {
    async probe() {
      let webgpu = false, info = 'unknown';
      try {
        const d = await getDevice();
        webgpu = !!d;
        const a = await navigator.gpu.requestAdapter();
        const ai = a && (a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null));
        if (ai) info = (ai.vendor || '?') + ' / ' + (ai.architecture || '?') + ' / ' + (ai.description || '');
      } catch (e) { webgpu = false; info = 'ERR ' + (e && e.message ? e.message : e); }
      let webgl2 = false;
      try { webgl2 = !!getGL(); } catch (e) { webgl2 = false; }
      return { webgpu: webgpu, webgl2: webgl2, info: info, timestamp: !!hasTs };
    },
    async run(spec) {
      try {
        let r;
        if (spec.backend === 'webgl2') {
          r = runWebgl2(spec);
        } else {
          const dev = await getDevice();
          dev.pushErrorScope('validation');
          dev.pushErrorScope('internal');
          try {
            r = await runWebgpu(spec);
            const e1 = await dev.popErrorScope();
            const e2 = await dev.popErrorScope();
            if (e1) throw new Error('internal: ' + e1.message);
            if (e2) throw new Error('validation: ' + e2.message);
          } catch (e) {
            try { await dev.popErrorScope(); } catch (_) {}
            try { await dev.popErrorScope(); } catch (_) {}
            throw e;
          }
        }
        return { ok: true, width: r.width, height: r.height, b64: bytesToB64(r.bytes), gpuNs: r.gpuNs, timingMethod: r.timingMethod };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e), width: 0, height: 0, b64: '', gpuNs: null, timingMethod: 'none' };
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
