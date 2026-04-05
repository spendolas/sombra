# Sombra — Complete WebGPU Migration — Agent Handoff

## Context

Phase 2a is partially working: single-pass shaders render on WebGPU. But the dual-backend approach (WebGPU for single-pass, WebGL2 fallback for multi-pass) is unnecessary complexity. We're scrapping it and going pure WebGPU.

After this handoff, the only time WebGL2 activates is when the browser doesn't support WebGPU at all.

---

## Task 1: Remove Dual-Backend Architecture

1. **Delete `src/renderer/dual-backend.ts`** (or whatever the composite renderer is called)
2. **Simplify the factory** in `create-renderer.ts`: try WebGPU, fall back to WebGL2. No per-graph switching. One renderer for the session.
3. **Update `__sombra.renderer.backend`** to reflect the session-level choice
4. **Remove any multi-pass detection → fallback logic** from the renderer or App.tsx

The factory becomes simply:

```typescript
export async function createShaderRenderer(canvas: HTMLCanvasElement): Promise<ShaderRenderer> {
  if (navigator.gpu) {
    try {
      const renderer = new WebGPUShaderRenderer();
      await renderer.init(canvas);
      console.log('[Sombra] Renderer backend: webgpu');
      return renderer;
    } catch (e) {
      console.warn('[Sombra] WebGPU init failed, falling back to WebGL2', e);
    }
  }
  const renderer = new WebGL2ShaderRenderer();
  await renderer.init(canvas);
  console.log('[Sombra] Renderer backend: webgl2');
  return renderer;
}
```

---

## Task 2: Multi-Pass WebGPU Rendering

Extend `WebGPUShaderRenderer` to handle multi-pass render plans.

### WGSL Assembler — Multi-Pass Support

Currently `wgsl-assembler.ts` only assembles single-pass shaders. Extend it to produce one WGSL program per pass, just like the GLSL assembler produces one GLSL string per pass.

Each intermediate pass:
- Renders to a `GPUTexture` (render attachment) instead of the canvas
- The next pass samples that texture as an input

The final pass renders to the canvas surface.

### RenderPlan Extension

The `wgsl` field in `RenderPlan` needs to support multiple passes:

```typescript
wgsl?: {
  passes: Array<{
    shaderCode: string;
    uniformLayout: UniformBufferLayout;
    textureBindings: TextureBinding[];
    // Which previous pass textures this pass samples
    inputTextures: Array<{ passIndex: number; samplerName: string }>;
  }>;
};
```

### WebGPU Multi-Pass Render Loop

```
Pass 0 → render to intermediateTexture[0]
Pass 1 → sample intermediateTexture[0], render to intermediateTexture[1]
...
Pass N-1 → sample intermediateTexture[N-2], render to canvas
```

For each intermediate pass:

```typescript
const intermediateTexture = device.createTexture({
  size: [width, height],
  format: this.canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

Bind the previous pass's texture in the next pass's bind group:

```typescript
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(1),  // group 1 for textures
  entries: [
    { binding: 0, resource: previousPassTexture.createView() },
    { binding: 1, resource: this.linearSampler },
  ],
});
```

### Intermediate Texture Management

- Allocate on render plan update (same as WebGL FBO allocation)
- Resize when canvas resizes
- Destroy on plan change or renderer dispose
- Respect the existing cap: 8 intermediate textures on desktop, 4 on mobile

### Per-Pass Dirty Propagation

Port the existing dirty propagation logic: only re-render passes whose uniforms changed. For clean passes, reuse the previously rendered intermediate texture. This is the same optimization the WebGL renderer has.

### Per-Pass Uniform Buffers

Each pass may use different uniforms (different nodes live in different passes). Either:
- One uniform buffer per pass (cleanest, matches the per-pass program model)
- One shared buffer with all uniforms, each pass reads its subset

Recommend one buffer per pass — it matches how each pass has its own pipeline and bind group.

### Per-Pass Texture Filtering

The existing WebGL path supports per-pass texture filter settings (linear vs nearest, e.g., Pixelate uses nearest). Map this to sampler configuration in WebGPU:

```typescript
const sampler = device.createSampler({
  minFilter: pass.textureFilter === 'nearest' ? 'nearest' : 'linear',
  magFilter: pass.textureFilter === 'nearest' ? 'nearest' : 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
});
```

---

## Task 3: Multi-Pass WGSL Compilation in Worker

Extend the IR→WGSL compilation path in the worker to handle multi-pass graphs:

1. `partitionPasses()` already determines the pass boundaries (from the GLSL path) — reuse this
2. For each pass, collect the IR from nodes in that pass
3. Run the WGSL assembler per pass
4. Include inter-pass texture sampler declarations in each pass's WGSL
5. Handle node re-emission (same node appearing in multiple passes)

The WGSL for a non-final pass that samples a previous pass looks like:

```wgsl
@group(1) @binding(0) var u_pass0_tex: texture_2d<f32>;
@group(1) @binding(1) var u_pass0_samp: sampler;

// ... node code that calls textureSample(u_pass0_tex, u_pass0_samp, coords) ...
```

---

## Task 4: Preview Renderer on WebGPU

Replace `WebGL2PreviewRenderer` with a WebGPU implementation, or make the existing `WebGPUShaderRenderer` handle both use cases.

### Key difference from main renderer: readback

The preview renderer needs to read pixel data back to the CPU to produce `ImageBitmap` thumbnails.

WebGPU readback flow:
1. Render to an 80×80 texture (not the canvas)
2. Copy the texture to a staging buffer with `commandEncoder.copyTextureToBuffer()`
3. `await stagingBuffer.mapAsync(GPUMapMode.READ)`
4. Read the data: `new Uint8Array(stagingBuffer.getMappedRange())`
5. Convert to ImageBitmap
6. `stagingBuffer.unmap()`

### Batched readback

Instead of reading one thumbnail at a time (sync, like WebGL), batch all pending previews:

1. For each dirty node: render to a per-node 80×80 texture
2. Copy all results to staging buffers (or one large staging buffer)
3. Submit all commands in one `queue.submit()`
4. `mapAsync` the staging buffer(s)
5. When resolved, extract all ImageBitmaps and write to the preview store via `setBatchPreviews()`

This is more efficient than the WebGL sync path — one GPU submission for all thumbnails instead of interleaved render→readPixels→render→readPixels.

### Single GPUDevice

Use the same `GPUDevice` for both main rendering and preview rendering. No separate context needed (unlike the WebGL two-context architecture). The preview renderer just creates its own textures and pipelines on the shared device.

### Preview Scheduler Updates

The scheduler already uses `await` on `renderPreview()` (from Phase 0). Now that readback is genuinely async, the batching model changes:

- Remove the 8ms-per-frame budget (it was based on sync readback timing)
- Instead: submit all dirty nodes in one batch, await the results, update the store
- The adaptive throttle (200ms/500ms/1000ms based on canvas size) still applies for time-live refreshes

### Multi-Pass Preview

Port the ping-pong buffer approach to WebGPU. Since WebGPU can create arbitrary textures cheaply, you can just allocate one intermediate texture per pass (no need for ping-pong). The preview path for multi-pass:

1. For each intermediate pass: render to an 80×80 intermediate texture
2. Final pass: render to the 80×80 readback texture
3. Copy to staging buffer → mapAsync → ImageBitmap

---

## Task 5: Clean Up

1. **Remove WebGL preview renderer entirely** — the WebGPU preview renderer replaces it
2. **Remove the OffscreenCanvas** — WebGPU doesn't need a separate canvas for preview
3. **Update `create-renderer.ts`** — `createPreviewRenderer()` should create a WebGPU preview renderer using the same device as the main renderer (pass the device as a parameter), or fall back to WebGL2 if WebGPU isn't available
4. **Remove the old `webglcontextlost`/`webglcontextrestored` event handling** from the WebGPU path — use `device.lost` promise instead
5. **Clean up any dual-backend remnants** — imports, types, conditional paths

### File structure after cleanup

```
src/renderer/
  types.ts                    # ShaderRenderer + PreviewRenderer interfaces (unchanged)
  create-renderer.ts          # Factory: WebGPU or WebGL2 (simplified, no dual-backend)

src/webgpu/
  renderer.ts                 # WebGPUShaderRenderer — single-pass AND multi-pass
  preview-renderer.ts         # WebGPU preview renderer — async readback, batched

src/webgl/
  renderer.ts                 # WebGL2ShaderRenderer (kept as browser fallback)
  preview-renderer.ts         # WebGL2PreviewRenderer (kept as browser fallback)
  preview-scheduler.ts        # Shared between both backends (async contract)
```

---

## Task 6: Misc Fixes (bundle with this work)

### 6a: Normalize Box/Value noise scale

Box and Value noise appear visually larger than other types at the same scale setting. Normalize the internal grid frequency so all noise types produce similar feature sizes at scale=1.0.

### 6b: Clarify Box Freq parameter

The `boxFreq` parameter on the Noise node (visible only for Box type) overlaps with SRT scale. Either:
- Rename to "Cell Count" or "Grid Density" for clarity
- Or remove it and let SRT scale handle the sizing (simpler, fewer controls)

Decide based on whether there's a legitimate use case for having both. If not, remove `boxFreq` and adjust the default box noise scale to match other noise types at scale=1.

---

## Verification

After all tasks:

- [ ] `tsc --noEmit` and `npm run build` clean
- [ ] `[Sombra] Renderer backend: webgpu` on startup
- [ ] Single-pass graphs render correctly (all 6 noise types, patterns, math nodes)
- [ ] Multi-pass graphs render correctly (Noise → Color Ramp → Pixelate via texture input)
- [ ] Multi-pass graphs render correctly (Noise → Warp via texture input)
- [ ] Uniform fast path works in both single-pass and multi-pass
- [ ] Recompile path works (noise type switch, adding/removing nodes)
- [ ] Preview thumbnails render on initial load (no interaction needed)
- [ ] Preview thumbnails update on slider drag (upstream + downstream propagation)
- [ ] Preview thumbnails work for multi-pass graphs
- [ ] Animation works (Time node → continuous motion)
- [ ] Quality tiers work (visual resolution changes, ribs don't change width)
- [ ] Image node works (if testable — loads texture, renders correctly)
- [ ] Canvas resize works
- [ ] Viewer works on WebGPU
- [ ] Viewer matches Preview output
- [ ] Window reload at any size produces correct output
- [ ] Console clean — no WebGPU/WGSL errors
- [ ] `__sombra.renderer.backend` returns `'webgpu'`
- [ ] WebGL2 fallback still works (test by disabling WebGPU in chrome://flags if possible)
- [ ] Box and Value noise scale normalized to match other types at scale=1

---

## Deliverables

Report: `docs/migration/phase2-complete-report.md` covering:
- Multi-pass WebGPU architecture (texture management, per-pass pipelines, dirty propagation)
- Preview renderer async readback approach (batching, staging buffers)
- Single-device architecture (how main + preview share one GPUDevice)
- Per-pixel visual regression for 5 representative graphs (single-pass and multi-pass)
- Any WGSL compilation issues encountered in multi-pass
- Performance comparison: WebGPU vs WebGL2 for the same graphs (if measurable)
- What was removed (dual-backend, OffscreenCanvas, etc.)

---

## Constraints

- WebGL2 backend stays in the codebase as a browser fallback — do not delete it
- Do not touch node `glsl()` functions (except for the Box/Value noise scale fix in Task 6)
- Do not start Phase 3 (export pipeline)
- `tsc --noEmit` and `npm run build` after each task completes
