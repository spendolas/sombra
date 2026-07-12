# Sombra — WebGPU Preview Renderer (Task 4 + 5) — Agent Handoff

## Context

The WebGPU migration is complete for the main renderer. Single-pass and multi-pass shaders render on WebGPU with 159/159 WGSL GPU compilation tests passing. The one remaining piece is the preview thumbnail system, which still runs on a separate WebGL2 context via `WebGL2PreviewRenderer` + `OffscreenCanvas(80, 80)`.

This handoff builds the IR subgraph compiler, the WebGPU preview renderer, and cleans up the WebGL2 preview path.

### Relevant files to read first

- `src/compiler/subgraph-compiler.ts` (~288 lines) — current GLSL subgraph compiler. This is what you're mirroring.
- `src/webgl/preview-renderer.ts` — current WebGL2 preview renderer. This is what you're replacing.
- `src/webgl/preview-scheduler.ts` — schedules and batches preview renders. Already async (`Promise<ImageBitmap>`). Stays mostly unchanged.
- `src/compiler/ir/wgsl-assembler.ts` — assembles complete WGSL programs from IR. You'll reuse this.
- `src/webgpu/renderer.ts` — the main WebGPU renderer. The preview renderer shares its `GPUDevice`.

---

## Task 1: IR Subgraph Compiler

### What it does

For a given target node, compile a standalone shader that renders just that node's output. This is what drives preview thumbnails — each node gets its own mini-shader showing what it produces.

### How the GLSL subgraph compiler works (mirror this)

`src/compiler/subgraph-compiler.ts` does:

1. Takes a target node ID, the full graph (nodes + edges), and the node registry
2. Calls `topologicalSort()` starting from the target node (not Fragment Output) — this collects only the nodes upstream of the target
3. For each node in the sorted subgraph, calls `generateNodeGlsl()` to get the GLSL snippet
4. Assembles a fragment shader where the target node's output is assigned to `fragColor`
5. Returns the GLSL source string + uniforms list

### IR subgraph compiler

Create `src/compiler/ir-subgraph-compiler.ts`. Same algorithm, but:

1. Takes the same inputs (target node ID, graph, registry)
2. Same `topologicalSort()` from the target node
3. For each node, calls `ir()` instead of `glsl()` via the `IRContext`
4. Collects all `IRNodeOutput` results (statements, uniforms, functions, spatial transforms)
5. The target node's output variable gets assigned to the fragment output
6. Passes the collected IR through the WGSL assembler to produce a complete WGSL program

### Handle both single-pass and multi-pass subgraphs

A target node might be downstream of a texture boundary. For example, previewing a Warp node requires rendering its upstream source as a texture first, then sampling it. The subgraph compiler must detect texture boundaries and partition into passes — same as `partitionPasses()` does for the main graph.

Check how the GLSL subgraph compiler handles this (it may call into the same `partitionPasses` logic or have its own simplified version). Replicate the same behavior.

### Output type

```typescript
interface SubgraphCompileResult {
  // For WebGPU preview renderer
  wgsl: {
    passes: Array<{
      shaderCode: string;
      uniformLayout: UniformBufferLayout;
      textureBindings: TextureBinding[];
      inputTextures: Array<{ passIndex: number; samplerName: string }>;
    }>;
  };
  
  // Uniform values to upload
  userUniforms: UniformInfo[];
  
  // Whether the subgraph uses u_time (determines if preview needs continuous re-render)
  isTimeLive: boolean;
}
```

### Verify

- [ ] Compile a subgraph for a simple node (Noise) — produces valid WGSL
- [ ] Compile a subgraph for a node downstream of a texture boundary (Warp with wired source) — produces multi-pass WGSL
- [ ] All subgraph WGSL validates via `device.createShaderModule()` — extend the GPU validator to cover subgraph compilation
- [ ] `tsc --noEmit` and `npm run build` clean

---

## Task 2: WebGPU Preview Renderer

### Create `src/webgpu/preview-renderer.ts`

Implements `PreviewRenderer` from `src/renderer/types.ts`.

### Shared GPUDevice

The preview renderer does NOT create its own device. It receives the `GPUDevice` from the main renderer:

```typescript
export class WebGPUPreviewRenderer implements PreviewRenderer {
  readonly backend = 'webgpu' as const;
  
  constructor(private device: GPUDevice) {}
  
  async init(): Promise<void> {
    this.setupRenderTarget();   // 80×80 texture
    this.setupStagingBuffer();  // for readback
    this.setupFullscreenQuad(); // same 6-vertex quad
  }
}
```

No separate canvas, no OffscreenCanvas. Everything happens on GPU textures.

### Render target

An 80×80 `GPUTexture` used as the render attachment:

```typescript
this.renderTexture = this.device.createTexture({
  size: [80, 80],
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
```

### Staging buffer for readback

```typescript
this.stagingBuffer = this.device.createBuffer({
  size: 80 * 80 * 4,  // RGBA, 1 byte per channel
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
```

### Render + readback flow

```typescript
async renderPreview(
  subgraphResult: SubgraphCompileResult,
  time: number
): Promise<ImageBitmap | null> {
  // 1. Create or retrieve cached pipeline from WGSL
  const pipeline = await this.getOrCreatePipeline(subgraphResult);
  if (!pipeline) return null;
  
  // 2. Update uniform buffer
  this.writeUniforms(subgraphResult, time);
  
  // 3. Render to 80×80 texture
  const encoder = this.device.createCommandEncoder();
  
  // Handle multi-pass: render intermediate passes first
  for (const pass of subgraphResult.wgsl.passes.slice(0, -1)) {
    // Render to intermediate texture
    this.renderPass(encoder, pass, this.getIntermediateTexture(pass));
  }
  
  // Final pass renders to the readback texture
  const finalPass = subgraphResult.wgsl.passes[subgraphResult.wgsl.passes.length - 1];
  this.renderPass(encoder, finalPass, this.renderTexture);
  
  // 4. Copy to staging buffer
  encoder.copyTextureToBuffer(
    { texture: this.renderTexture },
    { buffer: this.stagingBuffer, bytesPerRow: 80 * 4 },
    [80, 80]
  );
  
  this.device.queue.submit([encoder.finish()]);
  
  // 5. Read back pixels
  await this.stagingBuffer.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(this.stagingBuffer.getMappedRange()).slice();
  this.stagingBuffer.unmap();
  
  // 6. Convert to ImageBitmap
  const imageData = new ImageData(new Uint8ClampedArray(data), 80, 80);
  return createImageBitmap(imageData);
}
```

### Batched rendering

The scheduler already collects dirty nodes and processes them in batches. For even better performance, the preview renderer can accept a batch:

```typescript
async renderBatch(
  batch: Array<{ nodeId: string; subgraph: SubgraphCompileResult }>
  time: number
): Promise<Map<string, ImageBitmap | null>> {
  const encoder = this.device.createCommandEncoder();
  
  // Render all previews, each to its own texture
  // Copy all to staging buffers
  // One queue.submit() for the entire batch
  
  this.device.queue.submit([encoder.finish()]);
  
  // One mapAsync for all results
  // Extract all ImageBitmaps
  
  return results;
}
```

This is the key performance advantage over WebGL2 — one GPU submission for all thumbnails instead of interleaved render→readPixels→render→readPixels.

However, this requires one staging buffer per node in the batch (or one large staging buffer subdivided). Start with the simple per-node approach first. Optimize to batch later if needed.

### Pipeline cache

Cache compiled pipelines by WGSL source hash. The preview renderer compiles many small shaders — one per node subgraph — so caching matters. Use the same LRU approach as the main renderer. Max 64 entries (matching the WebGL2 preview cache size).

### Y-flip

WebGPU renders with Y=0 at the top. The current WebGL2 preview renderer does a vertical pixel flip after readPixels because WebGL has Y=0 at the bottom. Check whether this flip is still needed with WebGPU — it likely isn't, but verify the ImageBitmap orientation is correct.

---

## Task 3: Scheduler Integration

### Update `src/webgl/preview-scheduler.ts`

The scheduler already works with the async `PreviewRenderer` interface. The main changes:

1. The scheduler receives a `PreviewRenderer` (now the WebGPU implementation)
2. The subgraph compilation path changes: instead of calling the GLSL subgraph compiler and passing GLSL to the preview renderer, it calls the IR subgraph compiler and passes the result to the WebGPU preview renderer
3. The `setBatchPreviews` store write stays the same

### Subgraph compilation in the worker

Currently the preview scheduler dispatches subgraph compilation to the Web Worker, which calls the GLSL subgraph compiler. Extend the worker to also handle IR subgraph compilation:

- Worker receives `{ type: 'preview', nodeId, nodes, edges, useIR: true }`
- Calls the IR subgraph compiler
- Returns the `SubgraphCompileResult` (WGSL + uniforms)

### Move scheduler to `src/renderer/` 

The scheduler is currently in `src/webgl/` but it's backend-agnostic. Move it to `src/renderer/preview-scheduler.ts` since it works with the `PreviewRenderer` interface.

---

## Task 4: Update Factory

Update `src/renderer/create-renderer.ts`:

```typescript
export async function createPreviewRenderer(
  device?: GPUDevice
): Promise<PreviewRenderer> {
  if (device) {
    // WebGPU path — share the main renderer's device
    const renderer = new WebGPUPreviewRenderer(device);
    await renderer.init();
    return renderer;
  }
  // WebGL2 fallback
  const renderer = new WebGL2PreviewRenderer();
  await renderer.init();
  return renderer;
}
```

In `App.tsx`, after creating the main WebGPU renderer, pass its device to the preview renderer factory. The main renderer needs a method to expose its device:

```typescript
interface ShaderRenderer {
  // ...existing methods...
  readonly device?: GPUDevice;  // only present on WebGPU backend
}
```

---

## Task 5: Cleanup

After the WebGPU preview renderer is working:

1. **Remove `src/webgl/preview-renderer.ts`** — replaced by WebGPU version
2. **Remove the OffscreenCanvas(80, 80)** creation — no longer needed
3. **Move `preview-scheduler.ts`** from `src/webgl/` to `src/renderer/`
4. **Remove the second WebGL2 context** — the only WebGL2 context left should be the fallback main renderer (which only activates when WebGPU is unavailable)
5. **Update imports** across the codebase
6. **Remove any `UNPACK_FLIP_Y_WEBGL`** references from the preview path (WebGPU handles orientation differently)

### Don't remove

- `src/webgl/renderer.ts` (WebGL2ShaderRenderer) — kept as browser fallback
- The WebGL2 preview renderer if the WebGL2 main renderer is active (browsers without WebGPU need both)

Structure this as: if WebGPU is available, use WebGPU for everything (main + preview). If not, use WebGL2 for everything (main + preview). No mixing.

---

## Verification

- [ ] `tsc --noEmit` and `npm run build` clean
- [ ] `__sombra.validateAllWGSL()` still passes 159/159
- [ ] Fresh app load: preview thumbnails visible on all connected nodes (no interaction needed)
- [ ] Thumbnails update on slider drag (upstream + downstream propagation)
- [ ] Thumbnails work for single-pass nodes (Noise, Math, Color)
- [ ] Thumbnails work for multi-pass nodes (Warp with texture input)
- [ ] Thumbnails work for time-live nodes (continuous re-render)
- [ ] Thumbnail orientation is correct (not flipped vertically)
- [ ] No OffscreenCanvas creation in WebGPU path
- [ ] Only one GPUDevice exists (shared between main + preview)
- [ ] Console clean — no WebGL errors from preview path when on WebGPU
- [ ] `__sombra.renderer.backend` returns `'webgpu'`
- [ ] WebGL2 fallback still works end-to-end (main + preview) when WebGPU is disabled
- [ ] Preview scheduler batching still works (batch Zustand writes, adaptive throttle)

---

## Constraints

- Do not touch the main WebGPU renderer (`src/webgpu/renderer.ts`) beyond exposing the device
- Do not modify node `glsl()` or `ir()` functions
- Start with simple per-node rendering. Batch optimization (one queue.submit for all thumbnails) is a nice-to-have, not required
- If the Y-flip behavior differs between WebGL2 and WebGPU, fix it — thumbnails must be right-side up
- `tsc --noEmit` and `npm run build` after each task
