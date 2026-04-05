# Sombra WebGPU Migration — Phase 2a: WebGPU Renderer — Agent Handoff

## Context

Phases 0, 1a, 1b, and 1c are complete. All 41 nodes have `ir()` functions. The IR produces valid GLSL and WGSL output. The `ShaderRenderer` interface is in place with a working WebGL2 backend.

This phase stands up the WebGPU renderer — **single-pass only**. Multi-pass and preview thumbnails stay on WebGL2 for now (Phase 2b).

Read the full migration plan (`sombra-webgpu-migration-plan-v2.md`), the Phase 1c report (`docs/migration/phase1c-report.md`), and the renderer surface audit (`docs/migration/renderer-surface-audit.md`) for context.

---

## Deliverables Overview

1. WGSL shader assembler (IR → complete WGSL program)
2. WebGPU renderer backend (`WebGPUShaderRenderer implements ShaderRenderer`)
3. Compile pipeline integration (feature flag: WebGPU or WebGL2)
4. Backend selection in factory
5. Viewer support

---

## Task 1: WGSL Shader Assembler

The IR WGSL backend (`src/compiler/ir/wgsl-backend.ts`) currently produces per-node WGSL code snippets. The GPU needs a **complete WGSL program**. Build the assembler.

### Create `src/compiler/ir/wgsl-assembler.ts`

This mirrors what `assembleFragmentShader()` does in `glsl-generator.ts` for GLSL — takes the full compilation output and produces a complete shader string.

### WGSL program structure

```wgsl
// Uniform buffer struct
struct Uniforms {
  u_time: f32,
  _pad0: f32,                    // padding to align vec2f
  u_resolution: vec2f,
  u_dpr: f32,
  u_ref_size: f32,
  u_viewport: vec2f,
  // User uniforms appended here, with alignment padding as needed
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// Texture bindings (if any image nodes — single-pass only for now)
@group(1) @binding(0) var u_abc_image_tex: texture_2d<f32>;
@group(1) @binding(1) var u_abc_image_samp: sampler;

// Vertex output struct
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_uv: vec2f,
}

// Vertex shader
@vertex fn vs_main(@location(0) a_position: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.v_uv = a_position * 0.5 + 0.5;
  out.position = vec4f(a_position, 0.0, 1.0);
  return out;
}

// Deduplicated helper functions
fn mod289_v3(x: vec3f) -> vec3f { ... }
fn snoise3d(v: vec3f) -> f32 { ... }

// Fragment shader
@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // Per-node code in execution order
  // References uniforms via uniforms.u_time, uniforms.u_resolution, etc.
  // ...
  return vec4f(color, 1.0);
}
```

### Key differences from the GLSL assembler

| Concern | GLSL | WGSL |
|---------|------|------|
| Uniform access | `u_time` (global) | `uniforms.u_time` (struct member) |
| Uniform declarations | `uniform float u_time;` per uniform | Single `struct Uniforms { ... }` + one binding |
| Texture + sampler | Combined `uniform sampler2D` | Separate `var<uniform>` for texture and sampler |
| Vertex/fragment in one file | Separate strings | Can be in one module (two entry points) |
| Output | `fragColor = vec4(...)` | `return vec4f(...)` |
| Built-in inputs | `gl_FragCoord` | `in.position` (via `@builtin(position)`) |
| UV varying | `in vec2 v_uv` / `out vec2 v_uv` | Struct field with `@location(0)` |
| Precision | `precision highp float;` | Not needed (f32 is always 32-bit) |

### Uniform buffer layout

WGSL has strict alignment rules. The assembler must compute byte offsets:

| Type | Size | Alignment |
|------|------|-----------|
| `f32` | 4 | 4 |
| `vec2f` | 8 | 8 |
| `vec3f` | 12 | 16 (!) |
| `vec4f` | 16 | 16 |
| `i32` | 4 | 4 |

The assembler must:
1. Start with built-in uniforms in a fixed order
2. Append user uniforms from the RenderPlan
3. Insert padding fields (`_padN: f32`) where alignment requires it
4. Output both the WGSL struct declaration AND a JavaScript-side layout map (byte offset per uniform name) so the renderer knows where to write each value in the `ArrayBuffer`

```typescript
interface UniformBufferLayout {
  totalSize: number;                       // in bytes, rounded up to 16-byte boundary
  offsets: Map<string, number>;            // uniform name → byte offset
  struct: string;                          // WGSL struct declaration string
}
```

### Uniform name rewriting

In the GLSL path, node code references `u_time` directly. In WGSL, it must reference `uniforms.u_time`. The assembler needs to rewrite uniform references in the per-node WGSL snippets.

Options:
- The WGSL backend always emits `uniforms.NAME` — simplest, but means the IR WGSL output differs structurally from GLSL output
- The assembler does a post-pass rewriting bare `u_NAME` → `uniforms.u_NAME` — preserves symmetry between backends but is fragile (regex on shader code)

**Recommendation:** Have the WGSL backend accept a configuration flag or prefix parameter. When assembling a full shader, pass `uniformPrefix: 'uniforms.'`. When generating standalone snippets for validation, pass no prefix. This keeps the backend clean and the assembler simple.

### `gl_FragCoord` → `in.position`

The GLSL codegen uses `gl_FragCoord.xy` in several nodes (auto_uv, Pixelate, etc.). In WGSL this becomes the fragment function's input parameter with `@builtin(position)`. The assembler or WGSL backend must handle this substitution.

### Output

```typescript
interface WGSLAssemblerOutput {
  shaderCode: string;                      // complete WGSL module (vertex + fragment)
  uniformLayout: UniformBufferLayout;      // byte layout for JS-side buffer
  textureBindings: TextureBinding[];       // group/binding indices for each texture
}

interface TextureBinding {
  samplerName: string;                     // original sampler2D name
  textureBinding: number;                  // @binding index for texture_2d
  samplerBinding: number;                  // @binding index for sampler
  group: number;                           // @group index
}
```

### Verify

- [ ] Assemble a complete WGSL program from a simple graph (Noise → Color Ramp → Fragment Output)
- [ ] Validate the WGSL output (Tint/Naga or at minimum check syntax)
- [ ] Uniform buffer layout has correct alignment and padding
- [ ] `gl_FragCoord` references rewritten to `in.position`
- [ ] Uniform references use struct member access (`uniforms.u_time`)

---

## Task 2: WebGPU Renderer Backend

### Create `src/webgpu/renderer.ts`

Implements `ShaderRenderer` from `src/renderer/types.ts`.

```typescript
export class WebGPUShaderRenderer implements ShaderRenderer {
  readonly backend = 'webgpu' as const;
  // ...
}
```

### Init

```typescript
async init(canvas: HTMLCanvasElement): Promise<void> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU not supported');
  
  this.device = await adapter.requestDevice();
  this.context = canvas.getContext('webgpu')!;
  this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  
  this.context.configure({
    device: this.device,
    format: this.canvasFormat,
    alphaMode: 'premultiplied',    // matches WebGL default
  });
  
  this.setupFullscreenQuad();
  this.setupBuiltinUniformBuffer();
  this.setupDeviceLostHandler();
}
```

### Fullscreen quad

Same 6-vertex, 2-triangle geometry. Create a `GPUBuffer` with `usage: VERTEX`:

```typescript
const vertices = new Float32Array([
  -1, -1,  1, -1,  -1, 1,
  -1,  1,  1, -1,   1, 1,
]);
this.quadBuffer = device.createBuffer({
  size: vertices.byteLength,
  usage: GPUBufferUsage.VERTEX,
  mappedAtCreation: true,
});
new Float32Array(this.quadBuffer.getMappedRange()).set(vertices);
this.quadBuffer.unmap();
```

### Uniform buffer

A single `GPUBuffer` for all uniforms. Layout computed by the WGSL assembler:

```typescript
this.uniformBuffer = device.createBuffer({
  size: layout.totalSize,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
this.uniformData = new ArrayBuffer(layout.totalSize);
this.uniformFloat32 = new Float32Array(this.uniformData);
```

Per-frame update — write all built-in values, then `writeBuffer` once:

```typescript
// Write built-in uniforms at their offsets
this.uniformFloat32[layout.offsets.get('u_time')! / 4] = time;
// ... etc for u_resolution, u_dpr, u_ref_size, u_viewport

device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
```

For `updateUniforms()` (the fast path — slider drags), write only the changed values at their offsets, then `writeBuffer` the affected range.

### Pipeline creation

Use `createRenderPipelineAsync` for non-blocking compilation:

```typescript
async updateRenderPlan(plan: RenderPlan): Promise<void> {
  // For single-pass, compile the IR to WGSL
  const assembled = assembleWGSL(plan);
  
  const shaderModule = this.device.createShaderModule({
    code: assembled.shaderCode,
  });
  
  // Check for compilation errors
  const info = await shaderModule.getCompilationInfo();
  for (const msg of info.messages) {
    if (msg.type === 'error') {
      console.error('WGSL compile error:', msg.message, msg.lineNum);
      return; // Keep old pipeline active
    }
  }
  
  this.pipeline = await this.device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 8,    // 2 x f32
        attributes: [{
          shaderLocation: 0,
          offset: 0,
          format: 'float32x2',
        }],
      }],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format: this.canvasFormat }],
    },
    primitive: { topology: 'triangle-list' },
  });
  
  // Create bind group with uniform buffer (+ textures if any)
  this.rebuildBindGroup(assembled);
  this.uniformLayout = assembled.uniformLayout;
}
```

### Pipeline cache

Cache by hash of the WGSL source (not the full string). Use a simple string hash function. LRU eviction — pipelines don't have a `.destroy()`, but dropping references allows GC.

```typescript
private pipelineCache = new Map<string, GPURenderPipeline>();
```

### Render

```typescript
render(time: number, resolution: [number, number], dpr: number, refSize: number): void {
  // Update uniform buffer
  this.writeBuiltinUniforms(time, resolution, dpr, refSize);
  
  const encoder = this.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: this.context.getCurrentTexture().createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  
  pass.setPipeline(this.pipeline);
  pass.setBindGroup(0, this.uniformBindGroup);
  if (this.textureBindGroup) {
    pass.setBindGroup(1, this.textureBindGroup);
  }
  pass.setVertexBuffer(0, this.quadBuffer);
  pass.draw(6);
  pass.end();
  
  this.device.queue.submit([encoder.finish()]);
}
```

### Image textures

```typescript
async uploadImageTexture(samplerName: string, image: HTMLImageElement): Promise<void> {
  const bitmap = await createImageBitmap(image);
  
  const texture = this.device.createTexture({
    size: [bitmap.width, bitmap.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING |
           GPUTextureUsage.COPY_DST |
           GPUTextureUsage.RENDER_ATTACHMENT,
  });
  
  this.device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: true },    // explicit Y-flip
    { texture },
    [bitmap.width, bitmap.height],
  );
  
  const sampler = this.device.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  
  // Store and rebuild bind group
  this.imageTextures.set(samplerName, { texture, sampler });
  this.rebuildBindGroup();
}
```

### Device lost handling

```typescript
private setupDeviceLostHandler(): void {
  this.device.lost.then((info) => {
    console.warn('WebGPU device lost:', info.reason, info.message);
    if (info.reason === 'destroyed') return;  // intentional disposal
    
    // Re-request device and reinitialize
    this.adapter.requestDevice().then(device => {
      this.device = device;
      this.reinitialize();
      this.deviceLostCallback?.();
    });
  });
}
```

### Clear

```typescript
clear(): void {
  const encoder = this.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: this.context.getCurrentTexture().createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.end();
  this.device.queue.submit([encoder.finish()]);
}
```

### Dispose

```typescript
dispose(): void {
  this.quadBuffer?.destroy();
  this.uniformBuffer?.destroy();
  for (const { texture } of this.imageTextures.values()) {
    texture.destroy();
  }
  this.device?.destroy();
}
```

### Canvas resize

```typescript
resize(width: number, height: number): void {
  // WebGPU context auto-resizes when canvas dimensions change.
  // No explicit resize needed for single-pass (no intermediate textures).
  // Just ensure the uniform buffer gets updated resolution on next render.
}
```

---

## Task 3: Compile Pipeline Integration

The compiler currently always produces GLSL via `assembleFragmentShader()`. Add a feature flag to produce WGSL instead.

### Approach

**Do NOT replace the GLSL path.** Add a parallel path that's activated by a flag.

In `src/compiler/glsl-generator.ts` (or a new sibling file), add a function that:

1. Takes the same inputs as `compileSinglePass()` — the sorted nodes, edges, and params
2. Calls each node's `ir()` function instead of `glsl()` to build the IR
3. Passes the IR through the WGSL assembler
4. Returns the WGSL shader string + uniform layout alongside the existing RenderPlan

### RenderPlan extension

Add optional WGSL fields to the existing `RenderPlan` type:

```typescript
interface RenderPlan {
  // Existing fields (GLSL path)
  passes: PassInfo[];
  userUniforms: UniformInfo[];
  isTimeLiveAtOutput: boolean;
  qualityTier: QualityTier;
  
  // New fields (WebGPU path, optional — only present when IR path is active)
  wgsl?: {
    shaderCode: string;
    uniformLayout: UniformBufferLayout;
    textureBindings: TextureBinding[];
  };
}
```

### Web Worker

The worker already receives nodes and edges and calls `compileGraph()`. Extend it to also run the IR→WGSL path when a flag is set:

```typescript
// In compiler.worker.ts message handler:
if (message.useIR) {
  plan.wgsl = assembleWGSLFromIR(nodes, edges, plan);
}
```

The flag comes from the renderer backend selection — if WebGPU is active, the worker produces WGSL alongside GLSL. If WebGL is active, it skips the IR/WGSL path entirely.

### Multi-pass: skip for now

If the graph requires multiple passes, fall back to GLSL + WebGL2 for this phase. The WebGPU renderer should only handle single-pass graphs. The factory or the renderer itself detects multi-pass plans and falls back:

```typescript
// In WebGPUShaderRenderer.updateRenderPlan:
if (plan.passes.length > 1) {
  console.warn('Multi-pass not yet supported on WebGPU, falling back to WebGL2');
  // Signal the app to swap to WebGL2 for this graph
  // OR: keep WebGL2 renderer as fallback alongside WebGPU
}
```

**Design decision for the agent:** How should the fallback work? Two options:

**Option A — Hot swap:** The factory creates both renderers at init. Single-pass graphs use WebGPU, multi-pass graphs swap to WebGL2 on the same canvas. More complex but seamless.

**Option B — Startup choice:** The factory picks one renderer at init based on feature detection. WebGPU is used only when available AND the graph is single-pass at first compile time. Simpler but can't switch dynamically.

**Go with Option A** — it's more work but it's the correct UX. Users shouldn't have to reload the page when they add a texture boundary to their graph.

---

## Task 4: Update Factory + Viewer

### Factory (`src/renderer/create-renderer.ts`)

```typescript
export async function createShaderRenderer(
  canvas: HTMLCanvasElement
): Promise<ShaderRenderer> {
  if (navigator.gpu) {
    try {
      const webgpuRenderer = new WebGPUShaderRenderer();
      await webgpuRenderer.init(canvas);
      
      // Also create WebGL2 as fallback for multi-pass
      const webglRenderer = new WebGL2ShaderRenderer();
      await webglRenderer.init(canvas);
      
      // Return a composite renderer that delegates based on pass count
      return new DualBackendRenderer(webgpuRenderer, webglRenderer);
    } catch (e) {
      console.warn('WebGPU init failed, falling back to WebGL2', e);
    }
  }
  
  const renderer = new WebGL2ShaderRenderer();
  await renderer.init(canvas);
  return renderer;
}
```

The `DualBackendRenderer` implements `ShaderRenderer` and internally delegates:
- `updateRenderPlan()`: if single-pass and WGSL available → WebGPU backend. If multi-pass → WebGL2 backend.
- `render()`: delegates to whichever backend is active
- `updateUniforms()`: delegates to active backend
- All other methods: delegate to active backend

**Important:** Both backends cannot have an active WebGL/WebGPU context on the same canvas simultaneously. When swapping backends:
- The inactive backend's context must be released or the canvas must be reconfigured
- Or: use separate canvases, overlaid, and swap visibility

**Investigate how to handle this.** It may be simpler to recreate the context on swap rather than maintaining two live contexts. Report your approach in the deliverables.

### Viewer (`src/viewer.ts`)

The viewer should use the same factory. Since the viewer currently only handles single-pass graphs (confirm this), it might always use WebGPU when available. If it can handle multi-pass, it needs the same dual-backend approach.

---

## Task 5: Visual Regression Baseline

Before declaring Phase 2a complete, capture per-pixel comparison data.

For 5 representative single-pass graphs:
1. Noise → Color Ramp → Fragment Output
2. FBM (6 octaves) → Brightness/Contrast → Fragment Output
3. Checkerboard with SRT transforms → Fragment Output
4. Gradient (radial) → Mix with time-driven sine → Fragment Output
5. Image node with cover fit mode → Fragment Output (if accessible)

Render each graph at a fixed 512×512 canvas on both WebGL2 and WebGPU backends. Export the raw pixel data. Compare per-pixel.

**Expected:** The outputs should be very close but may not be bitwise identical — floating point differences between GLSL and WGSL compilers are expected. Document the maximum per-channel difference observed. Anything above 2-3 out of 255 per channel warrants investigation.

---

## File Structure

New files:
```
src/compiler/ir/wgsl-assembler.ts      # IR → complete WGSL program
src/webgpu/renderer.ts                 # WebGPUShaderRenderer
src/renderer/dual-backend.ts           # DualBackendRenderer (WebGPU + WebGL2 fallback)
```

Modified files:
```
src/renderer/types.ts                  # RenderPlan extended with wgsl? field
src/renderer/create-renderer.ts        # Factory updated for WebGPU + dual backend
src/compiler/compiler.worker.ts        # IR/WGSL compilation flag
src/compiler/glsl-generator.ts         # (or new file) IR→WGSL compilation path
src/viewer.ts                          # Uses updated factory
```

---

## Verification

- [ ] `tsc --noEmit` and `npm run build` clean
- [ ] Simple single-pass graph renders on WebGPU (visually correct)
- [ ] Uniform fast path works on WebGPU (slider drag → smooth update)
- [ ] Recompile path works on WebGPU (dropdown change → new pipeline → correct output)
- [ ] Image texture loads and renders on WebGPU
- [ ] Pipeline cache avoids redundant compilation
- [ ] Device lost → recovery works
- [ ] Multi-pass graph falls back to WebGL2 seamlessly (no reload, no flicker)
- [ ] Switching from single-pass to multi-pass (by adding a texture boundary) triggers backend swap
- [ ] Switching from multi-pass to single-pass (by removing texture boundary) triggers backend swap back
- [ ] Viewer works on WebGPU
- [ ] Fallback to WebGL2 works when WebGPU is unavailable (test by disabling WebGPU in browser flags)
- [ ] Visual regression: per-pixel comparison within acceptable tolerance (document results)
- [ ] RAF loop, quality tiers, DPR capping all work on WebGPU backend
- [ ] Canvas resize works on WebGPU
- [ ] `REFERENCE_SIZE` constant (512) used correctly in WebGPU uniform buffer

---

## Deliverables

1. All new and modified files listed above
2. Report: `docs/migration/phase2a-report.md` covering:
   - WGSL assembler design decisions (uniform layout, binding strategy)
   - How the dual-backend canvas context swap works
   - Pipeline creation performance (async creation time for representative graphs)
   - Per-pixel visual regression results (5 graphs, max channel difference)
   - Any WGSL compilation issues encountered and how they were resolved
   - Any WebGPU API surprises or gotchas
   - Recommendations for Phase 2b (multi-pass + preview on WebGPU)

---

## Constraints

- Do not remove the WebGL2 backend — it's the permanent fallback
- Do not modify existing `glsl()` functions on any node
- Do not start Phase 2b (multi-pass/preview) — single-pass WebGPU only
- The IR→WGSL path must be feature-flagged, not forced — WebGL2 users must be unaffected
- `tsc --noEmit` and `npm run build` after each major milestone
