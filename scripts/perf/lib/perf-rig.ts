/**
 * perf-rig — a standalone instrumented executor for the compiler's OWN emitted
 * shaders, on a real GPU, on both backends. Cloned from
 * scripts/blur-bakeoff/phase10-aa-rig.ts and extended so EVERY pass is timed,
 * not just the final one.
 *
 * What changed vs phase10-aa-rig:
 *   - WebGPU: one timestamp query set of `count: 2*passCount`, a begin/end pair
 *     per pass, a single resolveQuerySet, BigUint64 readback → per-pass ns.
 *   - WebGL2: no usable EXT timer in Chrome, so per-pass GPU time is wall-clock
 *     around a forced-sync (1×1 readPixels) repeat loop per pass, labelled
 *     `timingMethod:'wall-clock'` so a reader discounts it against WebGPU.
 *   - `timeRepeats` amplification is now ADAPTIVE and per-run: a cheap sub-µs
 *     pass is redrawn N times so it clears the timer's resolution, while a heavy
 *     4K pass (already >> 1µs) stays at N=1 so we never TDR the GPU.
 *   - The final frame is read back every run so the caller can assert the output
 *     is non-degenerate (the mechanism-engaged variance gate).
 *
 * Contract (identical on both backends), matching src/webgpu/renderer.ts and
 * src/webgl/renderer.ts pass-boundary allocations:
 *   - output TOP-row-first (like Rgba8 everywhere in the bench)
 *   - intermediates rgba8unorm, linear filtered, clamp-to-edge, no mips/MSAA
 *   - built-in uniforms: u_resolution=u_viewport=device px, u_ref_size=512,
 *     u_dpr=the capped/scaled dpr, u_frame_scale as passed
 */

import { chromium, type Browser, type Page } from 'playwright-core'
import http from 'node:http'
import type { Rgba8 } from '../../blur-bakeoff/lib/image'

export type Backend = 'webgpu' | 'webgl2'

/** One pass, in whichever language the backend speaks (both texts carried). */
export interface PerfPass {
  wgsl: string
  glslFrag: string
  glslVert: string
  uniformOffsets: Record<string, number>
  uniformTotalSize: number
  textureBindings: Array<{ samplerName: string; textureBinding: number; samplerBinding: number; group: number }>
  inputTextures: Array<{ passIndex: number; samplerName: string }>
  userUniforms: Array<{ name: string; glslType: string; value: number | number[] }>
  filter?: 'linear' | 'nearest'
  /**
   * Fractional rasterisation scale for this pass (RenderPass.resolution). When
   * present and < 1 the pass renders to a target of round(W*scale)×round(H*scale)
   * and its u_viewport / u_dpr / u_frame_scale scale with it — exactly the real
   * renderer's per-pass geometry (src/renderer/pass-size.ts, writeMultiPass-
   * BuiltinUniforms). The LAST pass is always forced to full canvas regardless,
   * mirroring the swap-chain rule. Undefined ⇒ full resolution.
   */
  resolution?: number
}

export interface PerfRunSpec {
  backend: Backend
  width: number
  height: number
  dpr?: number
  frameScale?: number
  time?: number
  anchor?: [number, number]
  passes: PerfPass[]
  images?: Record<string, Rgba8>
  /** Cap on the adaptive redraw count for sub-µs amplification (default 200). */
  maxRepeats?: number
}

export interface PerfRunResult {
  image: Rgba8
  /** Per-pass GPU nanoseconds; entries are null when unmeasured. */
  gpuNsPerPass: Array<number | null>
  /** Sum of the per-pass ns, or null if any pass was unmeasured. */
  gpuNsTotal: number | null
  timingMethod: 'timestamp-query' | 'wall-clock' | 'none'
  /** Redraw count actually used (adaptive amplification). */
  repeats: number
}

export interface PerfRig {
  adapterInfo: string
  available: { webgpu: boolean; webgl2: boolean }
  hasTimestamp: boolean
  run(spec: PerfRunSpec): Promise<PerfRunResult>
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

export async function createPerfRig(): Promise<PerfRig> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>perf-rig</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  })
  const page: Page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.error('[perf-rig page]', m.text()) })
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.addScriptTag({ content: BROWSER_SIDE })

  const probe = await page.evaluate(async () =>
    await (window as unknown as { __perf: { probe(): Promise<{ webgpu: boolean; webgl2: boolean; info: string; timestamp: boolean }> } }).__perf.probe())

  return {
    adapterInfo: probe.info,
    available: { webgpu: probe.webgpu, webgl2: probe.webgl2 },
    hasTimestamp: probe.timestamp,

    async run(spec: PerfRunSpec): Promise<PerfRunResult> {
      const images: Record<string, { width: number; height: number; b64: string }> = {}
      for (const [k, v] of Object.entries(spec.images ?? {})) {
        images[k] = { width: v.width, height: v.height, b64: toBase64(flipRows(v)) }
      }
      const payload = {
        backend: spec.backend,
        width: spec.width,
        height: spec.height,
        dpr: spec.dpr ?? 1,
        frameScale: spec.frameScale ?? spec.dpr ?? 1,
        time: spec.time ?? 0,
        anchor: spec.anchor ?? [0.5, 0.5],
        maxRepeats: spec.maxRepeats ?? 200,
        passes: spec.passes,
        images,
      }
      const res = await page.evaluate(
        async (p) => await (window as unknown as {
          __perf: { run(p: unknown): Promise<{ ok: boolean; error?: string; width: number; height: number; b64: string; gpuNsPerPass: Array<number | null>; gpuNsTotal: number | null; timingMethod: string; repeats: number }> }
        }).__perf.run(p),
        payload,
      )
      if (!res.ok) throw new Error(`perf-rig ${spec.backend} run failed: ${res.error}`)
      const raw = Buffer.from(res.b64, 'base64')
      return {
        image: { width: res.width, height: res.height, data: new Uint8ClampedArray(raw) },
        gpuNsPerPass: res.gpuNsPerPass,
        gpuNsTotal: res.gpuNsTotal,
        timingMethod: res.timingMethod as PerfRunResult['timingMethod'],
        repeats: res.repeats,
      }
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

  // Per-pass target geometry, matching src/renderer/pass-size.ts + the renderer's
  // final-pass-forced-full rule. A pass with resolution < 1 rasterises at
  // round(W*scale)×round(H*scale); its u_viewport/u_dpr/u_frame_scale scale by
  // width/W. The LAST pass is always full canvas (swap-chain), whatever it
  // declared. Undefined/≥1 resolution ⇒ full. maxTex clamp is a no-op at the
  // resolutions this bench uses but kept for fidelity.
  function passGeom(passes, i, W, H, baseDpr, baseFrameScale, maxTex) {
    const isLast = i === passes.length - 1;
    const s = passes[i].resolution;
    if (isLast || s == null || !(s > 0) || s >= 1) {
      return { w: W, h: H, dpr: baseDpr, frameScale: baseFrameScale };
    }
    const hi = Math.max(1, Math.floor(maxTex || 16384));
    const sCeiling = hi / Math.max(W, H);
    const sFloor = 1 / Math.min(W, H);
    const sEff = Math.min(sCeiling, Math.max(s, sFloor));
    const w = Math.min(hi, Math.max(1, Math.round(W * sEff)));
    const h = Math.min(hi, Math.max(1, Math.round(H * sEff)));
    const ratio = w / Math.max(1, W);
    return { w, h, dpr: baseDpr * ratio, frameScale: baseFrameScale * ratio };
  }

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

  function fillUniforms(spec, pass, geom) {
    const size = Math.max(16, pass.uniformTotalSize);
    const f32 = new Float32Array(size / 4);
    const off = pass.uniformOffsets;
    const set = (name, vals) => {
      if (!(name in off)) return;
      const base = off[name] / 4;
      for (let k = 0; k < vals.length; k++) f32[base + k] = vals[k];
    };
    set('u_time', [spec.time]);
    set('u_resolution', [geom.w, geom.h]);
    set('u_dpr', [geom.dpr]);
    set('u_frame_scale', [geom.frameScale]);
    set('u_ref_size', [512]);
    set('u_viewport', [geom.w, geom.h]);
    set('u_anchor', spec.anchor);
    set('u_mouse', [0, 0]);
    for (const u of pass.userUniforms) set(u.name, Array.isArray(u.value) ? u.value : [u.value]);
    return { f32, size };
  }

  // Build all pipelines/bind groups ONCE, reuse across repeat rounds.
  async function buildWebgpu(spec, W, H) {
    const dev = await getDevice();
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

    const maxTex = dev.limits.maxTextureDimension2D;
    const passTextures = [];
    const passGeoms = [];
    const built = [];
    for (let i = 0; i < spec.passes.length; i++) {
      const pass = spec.passes[i];
      const geom = passGeom(spec.passes, i, W, H, spec.dpr, spec.frameScale, maxTex);
      passGeoms.push(geom);
      const target = dev.createTexture({ size: [geom.w, geom.h], format: 'rgba8unorm',
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

      const uf = fillUniforms(spec, pass, geom);
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

      built.push({ pipeline, bindGroups, target });
      passTextures.push(target);
    }
    return { dev, quadBuf, built, passTextures, passGeoms, imageTex };
  }

  // One encode+submit of the whole plan, R draws per pass, timed if useTs.
  async function encodeWebgpu(ctx, spec, W, H, R, useTs) {
    const dev = ctx.dev;
    const P = spec.passes.length;
    const nQueries = useTs ? 2 * P : 0;
    let qs = null, qbuf = null, qread = null;
    if (useTs) {
      qs = dev.createQuerySet({ type: 'timestamp', count: nQueries });
      qbuf = dev.createBuffer({ size: nQueries * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      qread = dev.createBuffer({ size: nQueries * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    const encoder = dev.createCommandEncoder();
    for (let i = 0; i < P; i++) {
      const b = ctx.built[i];
      const desc = {
        colorAttachments: [{ view: b.target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      };
      if (useTs) desc.timestampWrites = { querySet: qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
      const rp = encoder.beginRenderPass(desc);
      rp.setPipeline(b.pipeline);
      rp.setVertexBuffer(0, ctx.quadBuf);
      for (let g = 0; g < b.bindGroups.length; g++) rp.setBindGroup(g, b.bindGroups[g]);
      for (let k = 0; k < R; k++) rp.draw(6);
      rp.end();
    }
    if (useTs) encoder.resolveQuerySet(qs, 0, nQueries, qbuf, 0);

    // Read back the final target.
    const finalTex = ctx.passTextures[P - 1];
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

    let perPass = new Array(P).fill(null);
    if (useTs) {
      await qread.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(qread.getMappedRange().slice(0));
      qread.unmap();
      for (let i = 0; i < P; i++) {
        const delta = Number(t[2 * i + 1] - t[2 * i]);
        perPass[i] = delta > 0 ? delta / R : null;
      }
      qread.destroy(); qbuf.destroy(); qs.destroy();
    }
    return { bytes: out, perPass };
  }

  async function runWebgpu(spec) {
    const W = spec.width, H = spec.height;
    const P = spec.passes.length;
    const ctx = await buildWebgpu(spec, W, H);
    try {
      if (!hasTs) {
        // No feature → produce the frame but mark unmeasured.
        const r = await encodeWebgpu(ctx, spec, W, H, 1, false);
        return { width: W, height: H, bytes: r.bytes, gpuNsPerPass: new Array(P).fill(null), gpuNsTotal: null, timingMethod: 'none', repeats: 1 };
      }
      // Warm-up + rough measure at R=1 to size amplification.
      await encodeWebgpu(ctx, spec, W, H, 1, false);
      const rough = await encodeWebgpu(ctx, spec, W, H, 1, true);
      let minNs = Infinity;
      for (const v of rough.perPass) if (v != null && v < minNs) minNs = v;
      // Amplify only if the cheapest pass is under 2µs; cap by maxRepeats.
      let R = 1;
      if (Number.isFinite(minNs) && minNs > 0 && minNs < 2000) {
        R = Math.min(spec.maxRepeats | 0 || 200, Math.max(1, Math.ceil(5000 / minNs)));
      }
      const measured = (R > 1) ? await encodeWebgpu(ctx, spec, W, H, R, true) : rough;
      const perPass = measured.perPass;
      let total = 0, ok = true;
      for (const v of perPass) { if (v == null) { ok = false; break; } total += v; }
      return { width: W, height: H, bytes: measured.bytes, gpuNsPerPass: perPass, gpuNsTotal: ok ? total : null, timingMethod: 'timestamp-query', repeats: R };
    } finally {
      for (const t of ctx.passTextures) t.destroy();
      for (const k of Object.keys(ctx.imageTex)) ctx.imageTex[k].destroy();
    }
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
    const P = spec.passes.length;

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

    // Build programs + targets once. Per-pass geometry honours RenderPass.resolution.
    const maxTex = g.getParameter(g.MAX_TEXTURE_SIZE);
    const geoms = [];
    for (let i = 0; i < P; i++) geoms.push(passGeom(spec.passes, i, W, H, spec.dpr, spec.frameScale, maxTex));

    const passTex = [];
    const progs = [];
    const fbo = g.createFramebuffer();
    for (let i = 0; i < P; i++) {
      const pass = spec.passes[i];
      const target = makeTex(g, geoms[i].w, geoms[i].h, null);
      created.push(target);

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
      progs.push(prog);
      passTex.push(target);
    }

    const setUniforms = (prog, pass, geom) => {
      const setF = (nm, v) => { const l = g.getUniformLocation(prog, nm); if (l) g.uniform1f(l, v); };
      const set2 = (nm, a, b) => { const l = g.getUniformLocation(prog, nm); if (l) g.uniform2f(l, a, b); };
      setF('u_time', spec.time);
      setF('u_dpr', geom.dpr);
      setF('u_frame_scale', geom.frameScale);
      setF('u_ref_size', 512);
      set2('u_resolution', geom.w, geom.h);
      set2('u_viewport', geom.w, geom.h);
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
    };

    // Render pass i once (into its target), binding source textures.
    const renderPass = (i) => {
      const pass = spec.passes[i];
      const prog = progs[i];
      g.bindFramebuffer(g.FRAMEBUFFER, fbo);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, passTex[i], 0);
      const st = g.checkFramebufferStatus(g.FRAMEBUFFER);
      if (st !== g.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: 0x' + st.toString(16));
      g.useProgram(prog);
      setUniforms(prog, pass, geoms[i]);

      const inputMap = {};
      for (const it of pass.inputTextures) inputMap[it.samplerName] = it.passIndex;
      let unit = 0;
      for (const tb of pass.textureBindings) {
        const loc = g.getUniformLocation(prog, tb.samplerName);
        if (!loc) continue;
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

      g.viewport(0, 0, geoms[i].w, geoms[i].h);
      g.disable(g.BLEND);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.drawArrays(g.TRIANGLES, 0, 6);
      const de = g.getError();
      if (de !== g.NO_ERROR) throw new Error('pass ' + i + ' draw error 0x' + de.toString(16));
    };

    // First: correctness render of the whole chain (produces the final frame).
    for (let i = 0; i < P; i++) renderPass(i);

    // Then: per-pass wall-clock timing. Each pass's target already holds its
    // correct inputs, so we can re-time it in isolation with a 1x1 readPixels
    // fence forcing GPU completion. Adaptive R to clear timer resolution.
    const sync1 = new Uint8Array(4);
    const perPass = new Array(P).fill(null);
    const timeOnce = (i, R) => {
      g.bindFramebuffer(g.FRAMEBUFFER, fbo);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, passTex[i], 0);
      // warm
      g.drawArrays(g.TRIANGLES, 0, 6);
      g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, sync1);
      const t0 = performance.now();
      for (let k = 0; k < R; k++) g.drawArrays(g.TRIANGLES, 0, 6);
      g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, sync1);
      return (performance.now() - t0) / R;
    };
    let usedR = 1;
    for (let i = 0; i < P; i++) {
      // rebind program + uniforms + textures for pass i
      renderPass(i);
      const rough = timeOnce(i, 1) * 1e6; // ns
      let R = 1;
      if (rough > 0 && rough < 2000) R = Math.min(spec.maxRepeats | 0 || 200, Math.max(1, Math.ceil(5000 / rough)));
      usedR = Math.max(usedR, R);
      perPass[i] = timeOnce(i, R) * 1e6;
    }

    // Final frame readback (re-render the chain so targets are the true outputs).
    for (let i = 0; i < P; i++) renderPass(i);
    const px = new Uint8Array(W * H * 4);
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, passTex[P - 1], 0);
    g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
    const err = g.getError();
    if (err !== g.NO_ERROR) throw new Error('GL error 0x' + err.toString(16));

    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.deleteFramebuffer(fbo);
    for (const p of progs) g.deleteProgram(p);
    for (const t of created) g.deleteTexture(t);
    g.deleteBuffer(vbo);

    // readPixels gives bottom-row-first; contract is top-row-first.
    const out = new Uint8Array(W * H * 4);
    const stride = W * 4;
    for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * stride, (H - y) * stride), y * stride);

    let total = 0, okTotal = true;
    for (const v of perPass) { if (v == null) { okTotal = false; break; } total += v; }
    return { width: W, height: H, bytes: out, gpuNsPerPass: perPass, gpuNsTotal: okTotal ? total : null, timingMethod: 'wall-clock', repeats: usedR };
  }

  window.__perf = {
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
        return { ok: true, width: r.width, height: r.height, b64: bytesToB64(r.bytes), gpuNsPerPass: r.gpuNsPerPass, gpuNsTotal: r.gpuNsTotal, timingMethod: r.timingMethod, repeats: r.repeats };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e), width: 0, height: 0, b64: '', gpuNsPerPass: [], gpuNsTotal: null, timingMethod: 'none', repeats: 0 };
      }
    },
  };
})();
`
