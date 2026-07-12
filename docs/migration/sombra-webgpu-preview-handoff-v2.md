# Sombra — WebGPU Preview Renderer — Corrected Handoff v2

## Context

The WebGPU migration is complete for the main renderer. 167/167 WGSL GPU compilation tests pass. The one remaining piece is the preview thumbnail system, which still runs on a separate WebGL2 context via `WebGL2PreviewRenderer` + `OffscreenCanvas(80, 80)`.

This handoff builds the IR subgraph compiler, the WebGPU preview renderer, and cleans up the WebGL2 preview path. It incorporates corrections from a code-level review of the actual source files.

### Read these files before starting

- `src/compiler/subgraph-compiler.ts` — current GLSL subgraph compiler (the reference implementation)
- `src/webgl/preview-renderer.ts` — current WebGL2 preview renderer (what you're replacing)
- `src/webgl/preview-scheduler.ts` — schedules and batches preview renders
- `src/compiler/ir-compiler.ts` — existing IR compilation types (`WGSLMultiPassOutput`, `WGSLPassOutput`)
- `src/compiler/ir/wgsl-assembler.ts` — assembles complete WGSL programs from IR
- `src/webgpu/renderer.ts` — main WebGPU renderer (shares its GPUDevice with preview)
- `src/renderer/types.ts` — `ShaderRenderer` and `PreviewRenderer` interfaces
- `src/compiler/compiler.worker.ts` — worker message handler

---

## Critical Corrections from Review

These issues were found by auditing the actual source code against the original handoff. Each is addressed in the task descriptions below.

| # | Issue | Resolution |
|---|-------|------------|
| 1 | `renderPreview` signature mismatch — handoff proposed `SubgraphCompileResult` but interface takes `(fragmentShader, uniforms)` | Use opaque `CompiledPreview` union type |
| 2 | `bytesPerRow` must be multiple of 256 — 80×4=320 is not | Use 512 bytesPerRow, staging buffer = 512×80, strip padding on readback |
| 3 | `GPUDevice` not publicly exposed on main renderer | Pass device via factory, not via interface property |
| 4 | `Map` doesn't survive `postMessage` structured cloning | Serialize Maps to plain objects in worker, reconstruct on main thread |
| 5 | Test count stale (159 → 167) | Use 167/167 as baseline |
| 6 | `SubgraphCompileResult` duplicates existing types | Reuse/extend `WGSLMultiPassOutput` + `WGSLPassOutput` from `ir-compiler.ts` |
| 7 | Preview needs 6 built-in uniforms, not just time | Pack all 6: `u_time`, `u_resolution`, `u_ref_size`, `u_mouse`, `u_dpr`, `u_viewport` |
| 8 | `renderBatch` not in interface | Drop batch method from initial implementation — optimize later |
| 9 | Worker protocol change is larger than "add useIR flag" | New result shape, scheduler handler update, cache format change — detailed below |
| 10 | Pipeline compilation latency on cold start | Use `createRenderPipelineAsync` for preview path |

---

## Task 1: Opaque `CompiledPreview` Type

### Problem

The current `PreviewRenderer` interface:
```typescript
renderPreview(fragmentShader: string, uniforms: UniformUpload[]): Promise<ImageBitmap | null>
```

This is GLSL-specific. The WebGPU preview renderer needs WGSL + uniform buffer layout + texture bindings — a completely different shape.

### Solution

Introduce an opaque `CompiledPreview` type. The scheduler doesn't inspect it — it receives it from the worker and passes it to the renderer.

In `src/renderer/types.ts`:

```typescript
// Opaque compiled preview — contents differ by backend
type CompiledPreview = GLSLCompiledPreview | WGSLCompiledPreview;

interface GLSLCompiledPreview {
  backend: 'webgl2';
  fragmentShader: string;
  uniforms: UniformUpload[];
  // Multi-pass fields from existing PreviewCompilationResult
  passes?: Array<{ fragmentShader: string; uniforms: UniformUpload[] }>;
}

interface WGSLCompiledPreview {
  backend: 'webgpu';
  // Reuse existing types from ir-compiler.ts
  wgsl: WGSLMultiPassOutput;
  userUniforms: UniformInfo[];
  isTimeLive: boolean;
}

// Updated interface
interface PreviewRenderer {
  renderPreview(compiled: CompiledPreview, time: number): Promise<ImageBitmap | null>;
  renderMultiPassPreview(compiled: CompiledPreview, time: number): Promise<ImageBitmap | null>;
  // ...rest unchanged
}
```

### Migration

1. Update `PreviewRenderer` interface with new signatures
2. Update `WebGL2PreviewRenderer` to accept `CompiledPreview`, extract GLSL fields internally
3. Build `WebGPUPreviewRenderer` to accept `CompiledPreview`, extract WGSL fields internally
4. Update scheduler to pass `CompiledPreview` through without inspecting contents

---

## Task 2: IR Subgraph Compiler

### Create `src/compiler/ir-subgraph-compiler.ts`

Port the logic from `src/compiler/subgraph-compiler.ts` line by line. Same algorithm:

1. `topologicalSort()` from the target node (not Fragment Output)
2. For each node in sorted order, call `ir()` instead of `glsl()` via `IRContext`
3. Detect texture boundaries, partition into passes (reuse `partitionPasses` / `findTextureBoundaries`)
4. Handle node re-emission for cross-pass non-texture dependencies
5. Target node's output assigned to fragment output
6. Pass collected IR through WGSL assembler

### Output type

Reuse existing types — do NOT create new ones:

```typescript
interface IRSubgraphResult {
  wgsl: WGSLMultiPassOutput;           // from ir-compiler.ts (already exists)
  userUniforms: UniformInfo[];          // from existing types
  isTimeLive: boolean;
}
```

Where `WGSLMultiPassOutput` already contains `passes: WGSLPassOutput[]`, each with `shaderCode`, `uniformLayout`, `textureBindings`.

### Depth limit

The GLSL subgraph compiler has a depth limit of 6 passes. Preserve this.

### Map serialization for worker

`UniformBufferLayout.offsets` is a `Map<string, number>`. When sending results through `postMessage`, serialize to a plain object:

```typescript
// In worker, before postMessage:
const serialized = {
  ...result,
  wgsl: {
    passes: result.wgsl.passes.map(p => ({
      ...p,
      uniformLayout: {
        ...p.uniformLayout,
        offsets: Object.fromEntries(p.uniformLayout.offsets),
      }
    }))
  }
};

// On main thread, after receiving:
const deserialized = {
  ...data,
  wgsl: {
    passes: data.wgsl.passes.map(p => ({
      ...p,
      uniformLayout: {
        ...p.uniformLayout,
        offsets: new Map(Object.entries(p.uniformLayout.offsets)),
      }
    }))
  }
};
```

Or better: change `UniformBufferLayout.offsets` to `Record<string, number>` everywhere and avoid the problem entirely. This is a wider change but cleaner long-term.

---

## Task 3: WebGPU Preview Renderer

### Create `src/webgpu/preview-renderer.ts`

```typescript
export class WebGPUPreviewRenderer implements PreviewRenderer {
  readonly backend = 'webgpu' as const;
  
  constructor(private device: GPUDevice) {}
  
  async init(): Promise<void> {
    this.setupRenderTarget();
    this.setupStagingBuffer();
    this.setupFullscreenQuad();
    this.setupLinearSampler();
  }
}
```

### Shared GPUDevice — pass via constructor, not interface

The preview renderer receives the `GPUDevice` from the factory (which gets it from the main renderer). Do NOT add `device` to the `ShaderRenderer` interface — it's backend-specific.

In `create-renderer.ts`:

```typescript
export async function createPreviewRenderer(
  mainRenderer: ShaderRenderer
): Promise<PreviewRenderer> {
  if (mainRenderer.backend === 'webgpu') {
    // Get device from the concrete type, not the interface
    const device = (mainRenderer as WebGPUShaderRenderer).getDevice();
    const renderer = new WebGPUPreviewRenderer(device);
    await renderer.init();
    return renderer;
  }
  const renderer = new WebGL2PreviewRenderer();
  await renderer.init();
  return renderer;
}
```

Add a `getDevice(): GPUDevice` method to `WebGPUShaderRenderer` specifically (not to the interface).

### Render target: 80×80 texture

```typescript
this.renderTexture = this.device.createTexture({
  size: [80, 80],
  format: 'rgba8unorm',
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
```

### Staging buffer: bytesPerRow alignment

**WebGPU requires `bytesPerRow` to be a multiple of 256.** For an 80-pixel-wide RGBA texture:

- Actual data per row: 80 × 4 = 320 bytes
- Required bytesPerRow: 512 (next multiple of 256 above 320)
- Padding per row: 512 - 320 = 192 bytes
- Total staging buffer size: 512 × 80 = 40,960 bytes

```typescript
const ALIGNED_BYTES_PER_ROW = 512;  // Math.ceil(80 * 4 / 256) * 256

this.stagingBuffer = this.device.createBuffer({
  size: ALIGNED_BYTES_PER_ROW * 80,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
```

### Readback: strip padding

```typescript
await this.stagingBuffer.mapAsync(GPUMapMode.READ);
const rawData = new Uint8Array(this.stagingBuffer.getMappedRange());

// Strip row padding: copy 320 bytes per row, skip 192 padding bytes
const pixelData = new Uint8Array(80 * 80 * 4);
for (let row = 0; row < 80; row++) {
  pixelData.set(
    rawData.subarray(row * ALIGNED_BYTES_PER_ROW, row * ALIGNED_BYTES_PER_ROW + 80 * 4),
    row * 80 * 4
  );
}
this.stagingBuffer.unmap();

const imageData = new ImageData(new Uint8ClampedArray(pixelData.buffer), 80, 80);
return createImageBitmap(imageData);
```

### Built-in uniforms: all 6

Pack all 6 into the uniform buffer, matching the main renderer:

| Uniform | Type | Offset |
|---------|------|--------|
| `u_time` | f32 | 0 |
| `_pad0` | f32 | 4 |
| `u_resolution` | vec2f | 8 |
| `u_dpr` | f32 | 16 |
| `u_ref_size` | f32 | 20 |
| `u_viewport` | vec2f | 24 |
| `u_mouse` | vec2f | 32 |

For preview, `u_resolution` = `vec2f(80, 80)`, `u_dpr` = 1.0, `u_ref_size` = 512 (REFERENCE_SIZE constant), `u_viewport` = `vec2f(80, 80)`, `u_mouse` = `vec2f(0, 0)`.

### Pipeline creation: use async

Preview compiles many small shaders. Use `createRenderPipelineAsync` to avoid blocking the main thread during cold start:

```typescript
const pipeline = await this.device.createRenderPipelineAsync({
  layout: 'auto',
  vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexLayout] },
  fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
  primitive: { topology: 'triangle-list' },
});
```

### Pipeline cache

LRU cache, max 64 entries, keyed by hash of WGSL source. Match the WebGL2 preview cache strategy.

### Y-flip

WebGPU renders Y=0 at top. The WebGL2 preview renderer flips pixels vertically after readback. **The WebGPU renderer should NOT flip** — verify that thumbnails appear right-side up and remove any flip logic.

### Multi-pass preview

For nodes downstream of a texture boundary, render intermediate passes to 80×80 intermediate textures, then the final pass to the readback texture. Same logic as the main renderer but at 80×80. Reuse the same intermediate texture management pattern — allocate on demand, cap at 6 (matching subgraph depth limit).

### Render flow

```typescript
async renderPreview(compiled: CompiledPreview, time: number): Promise<ImageBitmap | null> {
  if (compiled.backend !== 'webgpu') return null;
  
  const { wgsl, userUniforms } = compiled;
  const passes = wgsl.passes;
  
  const encoder = this.device.createCommandEncoder();
  
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    const isLast = i === passes.length - 1;
    const target = isLast ? this.renderTexture : this.getIntermediateTexture(i);
    
    const pipeline = await this.getOrCreatePipeline(pass.shaderCode);
    
    // Write uniforms for this pass
    this.writePassUniforms(pass.uniformLayout, userUniforms, time);
    
    // Set up bind group (uniforms + input textures from previous passes)
    const bindGroup = this.createPassBindGroup(pipeline, pass, i);
    
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    
    renderPass.setPipeline(pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setVertexBuffer(0, this.quadBuffer);
    renderPass.draw(6);
    renderPass.end();
  }
  
  // Copy final result to staging buffer
  encoder.copyTextureToBuffer(
    { texture: this.renderTexture },
    { buffer: this.stagingBuffer, bytesPerRow: ALIGNED_BYTES_PER_ROW },
    [80, 80]
  );
  
  this.device.queue.submit([encoder.finish()]);
  
  // Async readback
  await this.stagingBuffer.mapAsync(GPUMapMode.READ);
  const bitmap = this.extractImageBitmap();
  this.stagingBuffer.unmap();
  
  return bitmap;
}
```

---

## Task 4: Worker Protocol Update

This is a bigger change than "add a flag." The worker currently returns GLSL-shaped results for preview. It needs to return backend-appropriate `CompiledPreview` objects.

### Current flow

```
Scheduler → Worker: { type: 'preview', targetNodeId, nodes, edges }
Worker: compileNodePreview() → PreviewCompilationResult (GLSL strings + uniforms)
Worker → Scheduler: { fragmentShader, userUniforms, passes }
Scheduler: passes result to WebGL2PreviewRenderer
```

### New flow

```
Scheduler → Worker: { type: 'preview', targetNodeId, nodes, edges, backend: 'webgpu' | 'webgl2' }
Worker: 
  if backend === 'webgpu':
    IR subgraph compiler → WGSLMultiPassOutput + uniforms
    Serialize Maps to plain objects
    Return { backend: 'webgpu', wgsl, userUniforms, isTimeLive }
  else:
    GLSL compileNodePreview() → existing result
    Return { backend: 'webgl2', fragmentShader, uniforms, passes }
Scheduler → Renderer: passes CompiledPreview through without inspecting
```

### Worker message types

```typescript
// Request
interface PreviewCompileRequest {
  type: 'preview';
  id: string;
  targetNodeId: string;
  nodes: SerializedNode[];
  edges: SerializedEdge[];
  backend: 'webgpu' | 'webgl2';
}

// Response — union
type PreviewCompileResponse = {
  type: 'preview';
  id: string;
  nodeId: string;
  result: CompiledPreview;
  durationMs: number;
};
```

### Scheduler cache format

The scheduler caches compiled previews. The cache key stays the same (based on graph topology hash). The cached value changes from `{ fragmentShader, uniforms }` to `CompiledPreview`. Since the type is a discriminated union (`backend` field), the cache works for both backends without separate caches.

The scheduler must tell the worker which backend to use. It gets this from the renderer's `backend` property.

---

## Task 5: Scheduler Integration

### Move `preview-scheduler.ts` to `src/renderer/`

It's backend-agnostic — it belongs with the renderer interfaces, not in `src/webgl/`.

### Pass backend info to worker

The scheduler knows its renderer's backend. Pass it in every preview compile request:

```typescript
worker.postMessage({
  type: 'preview',
  id: requestId,
  targetNodeId: nodeId,
  nodes: serializedNodes,
  edges: serializedEdges,
  backend: this.renderer.backend,  // 'webgpu' or 'webgl2'
});
```

### Handle new response shape

The `onWorkerMessage` handler currently destructures GLSL-specific fields. Update it to pass the `CompiledPreview` through:

```typescript
case 'preview':
  const compiled = message.result;  // CompiledPreview (opaque)
  const bitmap = await this.renderer.renderPreview(compiled, this.currentTime);
  if (bitmap) {
    this.pendingBitmaps.set(message.nodeId, bitmap);
  }
  break;
```

---

## Task 6: Factory Update

```typescript
export async function createPreviewRenderer(
  mainRenderer: ShaderRenderer
): Promise<PreviewRenderer> {
  if (mainRenderer.backend === 'webgpu') {
    const device = (mainRenderer as WebGPUShaderRenderer).getDevice();
    const renderer = new WebGPUPreviewRenderer(device);
    await renderer.init();
    return renderer;
  }
  const renderer = new WebGL2PreviewRenderer();
  await renderer.init();
  return renderer;
}
```

In `App.tsx`, update the init flow to pass the main renderer to the preview factory:

```typescript
const mainRenderer = await createShaderRenderer(canvas);
const previewRenderer = await createPreviewRenderer(mainRenderer);
```

---

## Task 7: Cleanup

After the WebGPU preview renderer is working:

1. **Move** `preview-scheduler.ts` from `src/webgl/` to `src/renderer/`
2. **Remove OffscreenCanvas** creation from the WebGPU path
3. **Remove the second WebGL2 context** from the WebGPU path
4. **Update imports** across the codebase
5. **Do NOT remove** `src/webgl/preview-renderer.ts` — it's still needed when the browser falls back to WebGL2

### Backend pairing rule

If WebGPU is available: WebGPU main renderer + WebGPU preview renderer (shared device)
If WebGL2 fallback: WebGL2 main renderer + WebGL2 preview renderer (separate contexts, existing behavior)

No mixing backends between main and preview.

---

## Technical Debt to Flag (not in scope, pre-Phase-3)

**IR type coercion uses WGSL-specific names.** `coerceTypeForIR()` emits `vec2f(...)` style constructors that get baked into IR expressions. This makes the IR not truly backend-agnostic — the GLSL backend would emit WGSL syntax if it used the same IR tree. Not a problem now (GLSL path uses old `glsl()` functions directly), but must be fixed before Phase 3's export pipeline needs IR→GLSL output. Resolution: coercions should use backend-neutral names (`vec2`, not `vec2f`), with each backend handling syntax in its lowering pass.

---

## Verification

- [ ] `tsc --noEmit` and `npm run build` clean
- [ ] `__sombra.validateAllWGSL()` still passes 167/167
- [ ] Fresh app load: preview thumbnails visible on all connected nodes without interaction
- [ ] Thumbnails update on slider drag (upstream + downstream propagation)
- [ ] Thumbnails correct for single-pass nodes (Noise, Math, Color)
- [ ] Thumbnails correct for multi-pass nodes (Warp with texture input, Reeded Glass)
- [ ] Thumbnails correct for time-live nodes (wired Time node → thumbnails animate)
- [ ] Thumbnail orientation correct (not vertically flipped)
- [ ] No OffscreenCanvas in WebGPU path
- [ ] Single GPUDevice shared between main + preview
- [ ] Console clean — no WebGL errors when on WebGPU
- [ ] `__sombra.renderer.backend` returns `'webgpu'`
- [ ] WebGL2 fallback still works end-to-end (main + preview) when WebGPU is disabled
- [ ] Scheduler batching and adaptive throttle still work
- [ ] Pipeline cold-start doesn't cause visible frame drops (async pipeline creation)
- [ ] Map serialization through worker doesn't lose data

---

## Constraints

- Port logic from the GLSL subgraph compiler line by line — do not reimagine
- Do not modify the main WebGPU renderer beyond adding `getDevice()`
- Do not modify node `glsl()` or `ir()` functions
- Do not fix the type coercion debt — flag only, fix before Phase 3
- Use `createRenderPipelineAsync` for all preview pipeline creation
- Start with simple per-node rendering — batch optimization is a later improvement
- `tsc --noEmit` and `npm run build` after each task
- Use `__sombra.validateAllWGSL()` as the regression gate after each task
