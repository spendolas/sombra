/**
 * Phase 10 rig — run Sombra's OWN emitted WGSL, verbatim, on a real GPU.
 *
 * `lib/gpu-rig.ts` has `captureRawGlsl`, but that is WebGL2-only and the artefact
 * under study is reported on the WebGPU path, so this adds the missing raw-WGSL
 * executor. It is deliberately a separate file rather than an edit to `lib/`: the
 * frost bake-off is running concurrently against that directory.
 *
 * What it reproduces from `src/webgpu/renderer.ts`:
 *   - rgba8unorm intermediate pass targets
 *   - linear / clamp-to-edge samplers for pass textures and image textures
 *   - explicit bind-group layouts (group 0 = uniform struct, group 1 = textures)
 *   - the exact built-in uniform values the renderer writes:
 *       u_resolution = u_viewport = drawing-buffer size in DEVICE px
 *       u_ref_size   = 512, u_dpr = the renderer's capped/scaled dpr
 *   - image textures uploaded flipped (the renderer uses imageOrientation:'flipY')
 *
 * Extra, not in the engine: `ssaa: N` wraps a pass's `fs_main` in an N x N
 * box-filtered supersample of the SAME shader, giving the brute-force ceiling.
 */

import { chromium, type Browser, type Page } from 'playwright-core'
import http from 'node:http'
import type { Rgba8 } from './lib/image'

export interface WgslPass {
  shaderCode: string
  /** uniform name -> byte offset, from WGSLPassOutput.uniformLayout.offsets */
  uniformOffsets: Record<string, number>
  uniformTotalSize: number
  textureBindings: Array<{ samplerName: string; textureBinding: number; samplerBinding: number; group: number }>
  /** which earlier pass each sampler reads */
  inputTextures: Array<{ passIndex: number; samplerName: string }>
  /** the pass's own user uniforms at compile-time values */
  userUniforms: Array<{ name: string; glslType: string; value: number | number[] }>
  /** N x N box supersample of this pass (1 or undefined = off) */
  ssaa?: number
  /** calibration only: negate the v_uv sub-pixel offset (known-bad wrapper) */
  ssaaBadSign?: boolean
  filter?: 'linear' | 'nearest'
}

export interface WgslRunSpec {
  width: number
  height: number
  /** value written to u_dpr (renderer: min(devicePixelRatio,2) * dprScale) */
  dpr?: number
  time?: number
  anchor?: [number, number]
  passes: WgslPass[]
  /** samplerName -> image for image-node textures (top-row-first; rig flips) */
  images?: Record<string, Rgba8>
}

export interface Phase10Rig {
  adapterInfo: string
  run(spec: WgslRunSpec): Promise<Rgba8>
  decodeImage(bytes: Uint8Array, mime: string, maxSize?: number): Promise<Rgba8>
  close(): Promise<void>
}

const FRAG_SIG = /@fragment\s+fn\s+fs_main\s*\(\s*in\s*:\s*VertexOutput\s*\)\s*->\s*@location\(0\)\s*vec4f\s*\{/

/**
 * Rewrite `fs_main` into a plain function and drive it N x N times per pixel.
 * The synthesized VertexOutput keeps position (y-DOWN, device px) and v_uv
 * (y-UP, 0..1) consistent with the real vertex stage: v_uv.y = 1 - pos.y/H.
 */
export function wrapSupersample(code: string, n: number, w: number, h: number, badSign = false): string {
  if (!FRAG_SIG.test(code)) throw new Error('phase10-rig: fs_main signature not found; assembler output changed')
  const inner = code.replace(FRAG_SIG, 'fn sombra_frag_inner(in: VertexOutput) -> vec4f {')
  // badSign is the deliberately-wrong control: v_uv is y-UP while @builtin(position)
  // is y-DOWN, so the sub-pixel offset must be negated in v_uv.y. Flipping it is the
  // known-bad the wrapper validation has to be able to see.
  const vySign = badSign ? '+' : '-'
  return `${inner}

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  var acc: vec4f = vec4f(0.0);
  let inv: f32 = 1.0 / f32(${n});
  for (var sy: i32 = 0; sy < ${n}; sy = sy + 1) {
    for (var sx: i32 = 0; sx < ${n}; sx = sx + 1) {
      let off = vec2f((f32(sx) + 0.5) * inv - 0.5, (f32(sy) + 0.5) * inv - 0.5);
      var s: VertexOutput;
      s.position = vec4f(in.position.x + off.x, in.position.y + off.y, in.position.z, in.position.w);
      s.v_uv = vec2f(in.v_uv.x + off.x / ${w.toFixed(1)}, in.v_uv.y ${vySign} off.y / ${h.toFixed(1)});
      acc = acc + sombra_frag_inner(s);
    }
  }
  return acc * (inv * inv);
}
`
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Flip rows so the uploaded texture matches the engine's flipY image upload. */
function flipRows(img: Rgba8): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4)
  const stride = img.width * 4
  for (let y = 0; y < img.height; y++) {
    const src = (img.height - 1 - y) * stride
    out.set(img.data.subarray(src, src + stride), y * stride)
  }
  return out
}

export async function createPhase10Rig(): Promise<Phase10Rig> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>phase10-rig</title>')
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

  const adapterInfo = await page.evaluate(async () =>
    await (window as unknown as { __p10: { probe(): Promise<string> } }).__p10.probe())
  if (adapterInfo.startsWith('ERR')) throw new Error(`WebGPU unavailable: ${adapterInfo}`)

  return {
    adapterInfo,
    async run(spec: WgslRunSpec): Promise<Rgba8> {
      const passes = spec.passes.map((p) => ({
        ...p,
        shaderCode: p.ssaa && p.ssaa >= 1
          ? wrapSupersample(p.shaderCode, p.ssaa, spec.width, spec.height, p.ssaaBadSign)
          : p.shaderCode,
      }))
      const images: Record<string, { width: number; height: number; b64: string }> = {}
      for (const [k, v] of Object.entries(spec.images ?? {})) {
        images[k] = { width: v.width, height: v.height, b64: toBase64(flipRows(v)) }
      }
      const payload = {
        width: spec.width,
        height: spec.height,
        dpr: spec.dpr ?? 1,
        time: spec.time ?? 0,
        anchor: spec.anchor ?? [0.5, 0.5],
        passes,
        images,
      }
      const res = await page.evaluate(
        async (p) => await (window as unknown as { __p10: { run(p: unknown): Promise<{ ok: boolean; error?: string; width: number; height: number; b64: string }> } }).__p10.run(p),
        payload,
      )
      if (!res.ok) throw new Error(`phase10 run failed: ${res.error}`)
      const raw = Buffer.from(res.b64, 'base64')
      return { width: res.width, height: res.height, data: new Uint8ClampedArray(raw) }
    },
    async decodeImage(bytes: Uint8Array, mime: string, maxSize?: number): Promise<Rgba8> {
      const res = await page.evaluate(
        async (p) => await (window as unknown as { __p10: { decode(p: unknown): Promise<{ ok: boolean; error?: string; width: number; height: number; b64: string }> } }).__p10.decode(p),
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

  let device = null;
  async function getDevice() {
    if (device) return device;
    if (!navigator.gpu) throw new Error('no navigator.gpu');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    device = await adapter.requestDevice();
    device.addEventListener && device.addEventListener('uncapturederror', (e) => {
      console.error('uncaptured', e.error && e.error.message);
    });
    return device;
  }

  async function runInner(spec) {
    const dev = await getDevice();
    const W = spec.width, H = spec.height;

    const quadBuf = dev.createBuffer({ size: QUAD.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(quadBuf, 0, QUAD);

    const linear = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const nearest = dev.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // image-node textures
    const imageTex = {};
    for (const name of Object.keys(spec.images || {})) {
      const im = spec.images[name];
      const t = dev.createTexture({
        size: [im.width, im.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      dev.queue.writeTexture({ texture: t }, b64ToBytes(im.b64), { bytesPerRow: im.width * 4, rowsPerImage: im.height }, [im.width, im.height]);
      imageTex[name] = t;
    }

    const passTextures = [];
    const encoder = dev.createCommandEncoder();

    for (let i = 0; i < spec.passes.length; i++) {
      const pass = spec.passes[i];

      const target = dev.createTexture({
        size: [W, H], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });

      const module = dev.createShaderModule({ code: pass.shaderCode });
      const info = await module.getCompilationInfo();
      const errs = info.messages.filter(m => m.type === 'error');
      if (errs.length) throw new Error('pass ' + i + ' WGSL: ' + errs.map(m => 'L' + m.lineNum + ':' + m.linePos + ' ' + m.message).join(' | '));

      // group 0: uniform struct
      const g0layout = dev.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      });
      const layouts = [g0layout];

      // group 1: textures + samplers (explicit, so unused-but-declared bindings still validate)
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

      // uniforms
      const size = Math.max(16, pass.uniformTotalSize);
      const ubo = dev.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
      for (const u of pass.userUniforms) {
        const v = Array.isArray(u.value) ? u.value : [u.value];
        set(u.name, v);
      }
      dev.queue.writeBuffer(ubo, 0, f32);

      const bindGroups = [dev.createBindGroup({ layout: g0layout, entries: [{ binding: 0, resource: { buffer: ubo } }] })];

      if (g1layout) {
        const samp = pass.filter === 'nearest' ? nearest : linear;
        const inputMap = {};
        for (const it of pass.inputTextures) inputMap[it.samplerName] = it.passIndex;
        const entries = [];
        for (const tb of pass.textureBindings) {
          let tex = null;
          if (tb.samplerName in inputMap) {
            const src = passTextures[inputMap[tb.samplerName]];
            if (!src) throw new Error('pass ' + i + ': missing source pass ' + inputMap[tb.samplerName]);
            tex = src;
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

      const rp = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      });
      rp.setPipeline(pipeline);
      rp.setVertexBuffer(0, quadBuf);
      for (let g = 0; g < bindGroups.length; g++) rp.setBindGroup(g, bindGroups[g]);
      rp.draw(6);
      rp.end();

      passTextures.push(target);
    }

    const finalTex = passTextures[passTextures.length - 1];
    const bytesPerRow = Math.ceil(W * 4 / 256) * 256;
    const staging = dev.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: finalTex }, { buffer: staging, bytesPerRow, rowsPerImage: H }, [W, H]);
    dev.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange());
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + W * 4), y * W * 4);
    staging.unmap();
    staging.destroy();
    for (const t of passTextures) t.destroy();
    for (const k of Object.keys(imageTex)) imageTex[k].destroy();

    return { width: W, height: H, bytes: out };
  }

  window.__p10 = {
    async probe() {
      try {
        const d = await getDevice();
        const a = await navigator.gpu.requestAdapter();
        let info = '';
        try { const ai = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null); info = ai ? (ai.vendor + ' / ' + ai.architecture + ' / ' + (ai.description || '')) : 'unknown'; } catch (e) { info = 'unknown'; }
        return d ? info : 'ERR no device';
      } catch (e) { return 'ERR ' + (e && e.message ? e.message : e); }
    },
    async run(spec) {
      const dev = await getDevice();
      dev.pushErrorScope('validation');
      dev.pushErrorScope('internal');
      try {
        const r = await runInner(spec);
        const e1 = await dev.popErrorScope();
        const e2 = await dev.popErrorScope();
        if (e1) throw new Error('internal: ' + e1.message);
        if (e2) throw new Error('validation: ' + e2.message);
        return { ok: true, width: r.width, height: r.height, b64: bytesToB64(r.bytes) };
      } catch (e) {
        try { await dev.popErrorScope(); } catch (_) {}
        try { await dev.popErrorScope(); } catch (_) {}
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
