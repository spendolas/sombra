# Sombra — WebGPU Migration Plan v2

**Status:** Revised — incorporates Phase 0 audit findings  
**Inputs:** `renderer-surface-audit.md`, `codegen-pipeline-audit.md`, `architecture-snapshot.md`  
**Principle:** Additive, not destructive. WebGL keeps working throughout.

---

## What the Audit Revealed

The original plan was broadly correct but missed several structural details that change the implementation approach:

### Confirmed assumptions
- Param classification (`recompile`/`uniform`/`renderer`) works exactly as described
- Web Worker compiler with dynamic debounce and request ID cancellation
- RAF hybrid mode driven by `isTimeLiveAtOutput`
- Quality tiers control performance knobs only, never codegen
- WebGL resource lifecycle is well-managed (program/shader deletion, partial-failure cleanup)
- 50 unique WebGL2 API calls across just 2 files — compact surface area

### New findings that change the plan

| # | Finding | Impact |
|---|---------|--------|
| 1 | **Two separate WebGL2 contexts** (main DOM canvas + preview OffscreenCanvas 80x80) | Renderer interface must handle both. WebGPU can simplify: one `GPUDevice` renders to multiple targets. |
| 2 | **Synchronous `readPixels` in preview pipeline** | Preview scheduler's 8ms-budget batching model (4 nodes/frame) depends on sync readback. WebGPU's `mapAsync()` is async — scheduler needs rework. |
| 3 | **41 nodes** (not 39): 26 trivial, 9 moderate, 6 involved | IR conversion is scoped more precisely now. Tier 3 (texture sampling) nodes are the real work. |
| 4 | **Multi-pass is fully functional** with FBO chains, ping-pong, per-pass dirty propagation, and node re-emission | Abstraction layer must handle render-texture allocation and inter-pass binding from day one. This isn't something to add later. |
| 5 | **Node re-emission** — same node's GLSL can appear in multiple passes | IR must track re-emitted nodes and ensure their uniforms bind in every pass. |
| 6 | **viewer.ts** is a standalone non-React entry point | Renderer interface cannot depend on React, hooks, or Zustand. |
| 7 | **No explicit WebGL context attributes** (relies on browser defaults) | WebGPU requires explicit `context.configure()` with format and alpha mode. |
| 8 | **`KHR_parallel_shader_compile` detected but unused** | WebGPU gives async pipeline creation for free via `createRenderPipelineAsync()`. |
| 9 | **Program cache keyed by full GLSL source string** | WebGPU pipelines are more expensive to create and involve more state. Need hash-based keys and async creation. |
| 10 | **Image Y-flip via global `UNPACK_FLIP_Y_WEBGL` state** | WebGPU uses per-copy `flipY` parameter. Every image upload must pass explicitly. |
| 11 | **No video/audio/webcam inputs** | These are new capabilities for the export pipeline, not migration concerns. |
| 12 | **Codegen is string templates via `definition.glsl(ctx: GLSLContext)`** | Each node has a single `glsl()` function returning a string snippet. IR replacement is per-node work. |
| 13 | **Function dedup uses content-addressed keys** via `ctx.functionRegistry` | IR must preserve this — shared functions (noise, HSV, FBM) are registered once and deduplicated by key. |
| 14 | **SRT framework** injects coordinate transform preamble for 12 spatial nodes | IR needs a spatial transform concept, not just raw code injection. |

---

## Revised Phase Structure

```
Phase 0  — Abstraction seam (revised scope)        ← NEXT
Phase 1a — IR for trivial nodes (26 nodes)          ← Proves the IR design
Phase 1b — IR for moderate nodes (9 nodes)          ← Noise/FBM functions, color ramp
Phase 1c — IR for involved nodes (6 nodes)          ← Texture sampling, multi-pass
Phase 2a — WebGPU main renderer                     ← Single-pass first
Phase 2b — WebGPU multi-pass + preview              ← FBOs, async readback
Phase 3  — Export pipeline & Web Component          ← Builds on all above
Phase 4  — Compute shader nodes (future)
```

The key change: **Phase 1 is now three sub-phases** instead of one monolith. Each sub-phase delivers working IR→GLSL output that can be diffed against the old direct codegen, before moving to harder nodes. Phase 2 is split into single-pass-first (less risk) and then multi-pass + preview (where the async readback problem lives).

---

## Phase 0 — Abstraction Seam (Revised)

**Goal:** Isolate all WebGL calls behind an interface. After this phase, the rest of Sombra talks to an abstraction, not to `gl.*` directly.  
**Changes to shipping product:** None.

### 0.1 — Define the renderer interface

Based on the audit, the interface needs to cover two distinct use cases:

```typescript
// Shared types
interface CompiledProgram {
  id: string;
}

interface RenderTarget {
  width: number;
  height: number;
}

interface UniformValue {
  name: string;
  value: number | number[];
}

// Main renderer interface (DOM canvas, multi-pass, animation loop)
interface ShaderRenderer {
  // Lifecycle
  init(canvas: HTMLCanvasElement): Promise<void>;
  dispose(): void;
  onDeviceLost(callback: () => void): void;

  // Render plan (from compiler output)
  updateRenderPlan(plan: RenderPlan): void;

  // Uniforms (fast path)
  updateUniforms(uniforms: UniformValue[]): void;

  // Textures
  uploadImageTexture(samplerName: string, image: HTMLImageElement): void;
  deleteImageTexture(samplerName: string): void;

  // Rendering
  render(time: number, resolution: [number, number], dpr: number, refSize: number): void;
  clear(): void;

  // Canvas management
  resize(width: number, height: number): void;

  // Info
  readonly backend: 'webgl2' | 'webgpu';
}

// Preview renderer interface (offscreen, sync/async readback)
interface PreviewRenderer {
  init(): Promise<void>;
  dispose(): void;

  renderPreview(
    source: string,
    uniforms: UniformValue[],
    time: number
  ): Promise<ImageBitmap>;  // NOTE: async for WebGPU, sync-wrapped for WebGL

  renderMultiPassPreview(
    passes: PassSource[],
    uniforms: UniformValue[],
    time: number
  ): Promise<ImageBitmap>;

  readonly backend: 'webgl2' | 'webgpu';
}
```

**Key design decisions in this interface:**

1. **`renderPreview` returns `Promise<ImageBitmap>`** even for WebGL. The WebGL implementation wraps the sync `readPixels` in an immediately-resolved promise. This lets the scheduler work with both backends through the same async contract without changing its batching logic — it just `await`s each render. The 8ms budget becomes a target rather than a hard sync boundary.

2. **`updateRenderPlan` takes the full `RenderPlan`** (which already exists as the compiler's output type). The renderer handles FBO allocation, program compilation, and multi-pass setup internally. The caller doesn't need to know about passes.

3. **`onDeviceLost`** replaces the WebGL `webglcontextlost`/`webglcontextrestored` event pattern. WebGPU uses `device.lost` promise → re-request device from adapter.

4. **No React dependency.** Both interfaces are plain TypeScript. `viewer.ts` can use them directly.

### 0.2 — Wrap existing WebGL renderers

Refactor `renderer.ts` → `WebGL2ShaderRenderer implements ShaderRenderer`  
Refactor `preview-renderer.ts` → `WebGL2PreviewRenderer implements PreviewRenderer`

This is mechanical: move the existing code behind the interface methods. The internal implementation doesn't change. The only structural change is that `renderPreview` now returns `Promise<ImageBitmap>` (trivially wrapped).

### 0.3 — Update all consumers

- `App.tsx`: create renderers via factory function, not direct `new WebGLRenderer()`
- `viewer.ts`: same factory function
- `use-live-compiler.ts`: call renderer through interface, not directly
- `preview-scheduler.ts`: switch to `await renderer.renderPreview()` pattern

### 0.4 — Verify

- [ ] `tsc --noEmit` and `vite build` clean
- [ ] No `gl.*` calls outside `src/webgl/` directory
- [ ] All renderer access goes through the interface
- [ ] Viewer still works standalone
- [ ] Preview thumbnails still render correctly
- [ ] Multi-pass rendering unchanged
- [ ] Context loss recovery still works

---

## Phase 1a — IR for Trivial Nodes (26 nodes)

**Goal:** Prove the IR design with the simplest nodes.  
**Scope:** All 26 pure-arithmetic nodes (math, vector, pattern, simple color, output).

### IR Design

The IR is a typed AST that represents shader operations without committing to GLSL or WGSL syntax:

```typescript
// Core IR types
type IRType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool' | 'sampler2D';

interface IRNode {
  kind: string;  // discriminant
}

// Expressions
interface IRLiteral extends IRNode { kind: 'literal'; type: IRType; value: number | number[]; }
interface IRVariable extends IRNode { kind: 'variable'; name: string; type: IRType; }
interface IRBinaryOp extends IRNode { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: IRExpr; right: IRExpr; type: IRType; }
interface IRCall extends IRNode { kind: 'call'; name: string; args: IRExpr[]; type: IRType; }
interface IRSwizzle extends IRNode { kind: 'swizzle'; expr: IRExpr; components: string; type: IRType; }
interface IRConstruct extends IRNode { kind: 'construct'; type: IRType; args: IRExpr[]; }
interface IRTernary extends IRNode { kind: 'ternary'; cond: IRExpr; then: IRExpr; else: IRExpr; type: IRType; }

type IRExpr = IRLiteral | IRVariable | IRBinaryOp | IRCall | IRSwizzle | IRConstruct | IRTernary;

// Statements
interface IRDeclare extends IRNode { kind: 'declare'; name: string; type: IRType; value: IRExpr; }
interface IRAssign extends IRNode { kind: 'assign'; name: string; value: IRExpr; }

type IRStatement = IRDeclare | IRAssign;

// Uniform declarations
interface IRUniform {
  name: string;
  type: IRType;
  updateMode: 'recompile' | 'uniform';
}

// A node's contribution to the shader
interface IRNodeOutput {
  statements: IRStatement[];           // code this node adds to main()
  uniforms: IRUniform[];               // uniforms this node requires
  standardUniforms: Set<string>;       // built-in uniforms needed (u_time, u_resolution, etc.)
}
```

### Per-node migration pattern

Each node's `glsl(ctx: GLSLContext) => string` becomes `ir(ctx: IRContext) => IRNodeOutput`. For trivial nodes this is nearly 1:1:

**Before (GLSL string):**
```typescript
// Mix node
glsl: (ctx) => `vec3 ${ctx.outputs.result} = mix(${ctx.inputs.a}, ${ctx.inputs.b}, ${ctx.inputs.factor});`
```

**After (IR):**
```typescript
ir: (ctx) => ({
  statements: [
    declare(ctx.outputs.result, 'vec3',
      call('mix', [variable(ctx.inputs.a), variable(ctx.inputs.b), variable(ctx.inputs.factor)])
    )
  ],
  uniforms: [],
  standardUniforms: new Set()
})
```

### GLSL backend: IR → GLSL

The IR-to-GLSL lowering is mechanical for trivial nodes:

| IR Node | GLSL Output |
|---------|-------------|
| `literal(float, 0.5)` | `0.5` |
| `literal(vec3, [1,0,0])` | `vec3(1.0, 0.0, 0.0)` |
| `variable('foo')` | `foo` |
| `binary('+', a, b)` | `(a + b)` |
| `call('mix', [a, b, c])` | `mix(a, b, c)` |
| `swizzle(v, 'xy')` | `v.xy` |
| `construct('vec2', [x, y])` | `vec2(x, y)` |
| `declare('x', 'float', expr)` | `float x = expr;` |

### WGSL backend: IR → WGSL

Key differences from GLSL:

| IR Node | GLSL | WGSL |
|---------|------|------|
| `literal(float, 0.5)` | `0.5` | `0.5` |
| `literal(vec3, [1,0,0])` | `vec3(1.0, 0.0, 0.0)` | `vec3f(1.0, 0.0, 0.0)` |
| `declare('x', 'float', expr)` | `float x = expr;` | `var x: f32 = expr;` (or `let` if never reassigned) |
| `declare('v', 'vec3', expr)` | `vec3 v = expr;` | `var v: vec3f = expr;` |
| Type in `construct` | `vec2(x, y)` | `vec2f(x, y)` |

Most built-in math functions (`mix`, `clamp`, `smoothstep`, `sin`, `cos`, `pow`, `abs`, `floor`, `fract`, `dot`, `length`, `normalize`) have **identical names** in GLSL and WGSL.

### Verification

- [ ] All 26 trivial nodes have `ir()` implementations
- [ ] IR → GLSL output matches old direct `glsl()` output for all 26 nodes (automated diff)
- [ ] IR → WGSL output validates via Tint/Naga for all 26 nodes
- [ ] Old `glsl()` path still exists as fallback (feature flag)

---

## Phase 1b — IR for Moderate Nodes (9 nodes)

**Scope:** Noise (2), FBM, HSV to RGB, Color Ramp, Dither, Random, plus non-texture paths of Warp and Reeded Glass.

### New IR concepts needed

**Shared functions** — these nodes register GLSL helper functions (noise, HSV conversion, bayer matrix) via `ctx.functionRegistry`. The IR needs:

```typescript
interface IRFunction {
  key: string;        // content-addressed dedup key (e.g., "snoise3d_01")
  name: string;       // function name in generated code
  params: { name: string; type: IRType }[];
  returnType: IRType;
  body: IRStatement[];
}

// Added to IRNodeOutput:
interface IRNodeOutput {
  statements: IRStatement[];
  uniforms: IRUniform[];
  standardUniforms: Set<string>;
  functions: IRFunction[];              // NEW: shared functions to register
}
```

The dedup key ensures each function is emitted once, matching the current `functionRegistry` behavior.

**SRT framework** — the 12 spatial nodes inject a coordinate transform preamble. Rather than baking this as raw statements, model it as an IR concept:

```typescript
interface IRSpatialTransform {
  coordsVar: string;            // input coords variable
  outputVar: string;            // transformed coords variable
  scaleUniform?: string;        // uniform name for scale
  rotateUniform?: string;       // uniform name for rotation
  translateUniform?: string;    // uniform name for translation
}

// Added to IRNodeOutput:
interface IRNodeOutput {
  // ...existing fields...
  spatialTransform?: IRSpatialTransform;  // NEW: if present, emitted before statements
}
```

Both backends know how to lower `IRSpatialTransform` into the appropriate code. This is cleaner than each node manually emitting the SRT preamble.

**Loops** — FBM uses a `for` loop with early break. The IR needs:

```typescript
interface IRForLoop extends IRNode {
  kind: 'for';
  iterVar: string;
  from: IRExpr;
  to: IRExpr;          // may be a literal (baked octave count)
  body: IRStatement[];
  earlyBreak?: IRExpr; // condition for break
}
```

### Migration approach

The ~300 lines of shared noise functions are the bulk of the work. These need to be expressed as `IRFunction` bodies. The GLSL backend emits them as-is; the WGSL backend transliterates.

Key GLSL→WGSL differences for noise functions:
- `mod(x, y)` → `x % y` (for floats) or a custom `mod_f32` function
- `fract(x)` → `fract(x)` (same)
- `floor(x)` → `floor(x)` (same)
- `vec3(float)` broadcast → `vec3f(float)` (same in WGSL, actually works)
- No `out` parameters in WGSL — need to restructure any functions that use them

### Verification

- [ ] All 9 moderate nodes have `ir()` implementations
- [ ] Noise functions emit correctly in both GLSL and WGSL
- [ ] Function deduplication works (same key → emitted once)
- [ ] SRT preamble generates correctly for spatial nodes
- [ ] FBM loop with early break generates correctly
- [ ] IR → GLSL diff matches old direct codegen

---

## Phase 1c — IR for Involved Nodes (6 nodes)

**Scope:** Warp, Pixelate, Reeded Glass, Polar Coordinates, Tile, Image — all texture-sampling nodes.

### New IR concepts needed

**Texture sampling:**

```typescript
interface IRTextureSample extends IRNode {
  kind: 'textureSample';
  sampler: string;      // sampler uniform name
  coords: IRExpr;       // UV coordinates
  type: IRType;         // return type (vec4)
}
```

GLSL: `texture(sampler, coords)`  
WGSL: `textureSample(texture, sampler, coords)` — note WGSL separates texture and sampler objects.

This is the biggest GLSL→WGSL divergence. In GLSL, `sampler2D` combines texture and sampler. In WGSL, they're separate bindings:

```wgsl
@group(0) @binding(0) var myTexture: texture_2d<f32>;
@group(0) @binding(1) var mySampler: sampler;
// ...
textureSample(myTexture, mySampler, coords)
```

The IR `textureSample` node abstracts over this — each backend handles the binding model differences.

**Multi-pass awareness:**

These nodes trigger pass partitioning. The IR doesn't need to know about passes (that's the compiler's job), but it does need to express that a node's input comes from a texture rather than a computation:

```typescript
interface IRTextureInput {
  samplerName: string;      // e.g., "u_pass0_tex"
  sourcePassIndex: number;  // which pass produced this texture
}
```

The `partitionPasses()` logic in `glsl-generator.ts` remains unchanged — it operates on the graph topology, not on the IR. But the IR output for texture-sampling nodes must include the texture sampling operations so both backends can lower them correctly.

### Node re-emission

The audit found that nodes referenced across pass boundaries via non-texture edges get their code re-emitted in the later pass. This is a **compiler concern, not an IR concern** — the compiler already handles it by calling `generateNodeGlsl()` again for the re-emitted node. With the IR, it calls `generateNodeIR()` again instead. The IR dedup (function registry by key) ensures shared functions aren't duplicated.

No IR changes needed — just ensure the re-emission path calls the IR codegen, not the old GLSL codegen.

### Verification

- [ ] All 6 texture-sampling nodes have `ir()` implementations
- [ ] Texture sampling generates correctly in both GLSL and WGSL
- [ ] Multi-pass graphs with texture boundaries still partition correctly
- [ ] Node re-emission works with IR path
- [ ] Image node with all 4 fit modes generates correctly
- [ ] Reeded Glass (most complex node) generates correctly in both languages
- [ ] IR → GLSL diff matches old direct codegen for representative multi-pass graphs

---

## Phase 2a — WebGPU Main Renderer (Single-Pass)

**Goal:** Sombra renders single-pass shaders on WebGPU when available.  
**Scope:** Main renderer only. Preview stays on WebGL for now.

### Implementation: `WebGPUShaderRenderer implements ShaderRenderer`

**Init:**
```typescript
async init(canvas: HTMLCanvasElement): Promise<void> {
  const adapter = await navigator.gpu.requestAdapter();
  this.device = await adapter.requestDevice();
  this.context = canvas.getContext('webgpu');
  this.context.configure({
    device: this.device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: 'premultiplied',  // matches WebGL default behavior
  });
  this.setupFullscreenQuad();
  this.setupBuiltinUniformBuffer();
}
```

**Uniform buffer layout:**

Instead of individual `gl.uniform*()` calls, pack all uniforms into a single buffer:

```typescript
// Built-in uniforms: always present, always at the start
// [u_time: f32, pad, u_resolution: vec2f, u_dpr: f32, u_ref_size: f32, u_viewport: vec2f]
// = 32 bytes (8 x f32), aligned to 16-byte boundary

// User uniforms: appended after built-ins
// Layout determined at compile time from the uniform list in RenderPlan
```

Single `device.queue.writeBuffer()` per frame for built-ins. User uniform updates write to the appropriate offset.

**Pipeline creation:**

```typescript
updateRenderPlan(plan: RenderPlan): void {
  const wgslSource = compileIRToWGSL(plan.passes[0].ir);  // or receive pre-compiled WGSL
  
  this.pipeline = this.device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: this.vertexModule, entryPoint: 'main' },
    fragment: {
      module: this.device.createShaderModule({ code: wgslSource }),
      entryPoint: 'main',
      targets: [{ format: this.canvasFormat }],
    },
    primitive: { topology: 'triangle-list' },
  });
}
```

Use `createRenderPipelineAsync` — this is the async compilation that `KHR_parallel_shader_compile` was supposed to provide but never did. The editor can show a loading state while the pipeline compiles.

**Pipeline cache:**

Use a hash of the WGSL source as the cache key (not the full string). Cache `GPURenderPipeline` objects with LRU eviction. Since pipeline creation is more expensive than WebGL program linking, the cache is more important here.

**Render:**

```typescript
render(time, resolution, dpr, refSize): void {
  // Update built-in uniform buffer
  this.builtinData[0] = time;
  this.builtinData[2] = resolution[0]; this.builtinData[3] = resolution[1];
  this.builtinData[4] = dpr;
  this.builtinData[5] = refSize;
  this.device.queue.writeBuffer(this.builtinBuffer, 0, this.builtinData);

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
  pass.setBindGroup(0, this.bindGroup);
  pass.setVertexBuffer(0, this.quadBuffer);
  pass.draw(6);
  pass.end();
  this.device.queue.submit([encoder.finish()]);
}
```

**Device lost handling:**

```typescript
this.device.lost.then((info) => {
  console.warn('WebGPU device lost:', info.reason);
  // Re-request device from adapter and re-init
  this.adapter.requestDevice().then(device => {
    this.device = device;
    this.reinitialize();
  });
});
```

**Image textures:**

```typescript
uploadImageTexture(samplerName: string, image: HTMLImageElement): void {
  const bitmap = await createImageBitmap(image);
  const texture = this.device.createTexture({
    size: [bitmap.width, bitmap.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  this.device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: true },  // explicit Y-flip (was global state in WebGL)
    { texture },
    [bitmap.width, bitmap.height]
  );
  // Store texture + create sampler, rebuild bind group
}
```

### Backend selection factory

```typescript
async function createShaderRenderer(canvas: HTMLCanvasElement): Promise<ShaderRenderer> {
  if (navigator.gpu) {
    try {
      const renderer = new WebGPUShaderRenderer();
      await renderer.init(canvas);
      return renderer;
    } catch (e) {
      console.warn('WebGPU init failed, falling back to WebGL2', e);
    }
  }
  const renderer = new WebGL2ShaderRenderer();
  await renderer.init(canvas);
  return renderer;
}
```

### Verification

- [ ] Single-pass shaders render identically on WebGPU and WebGL2
- [ ] Uniform fast path works (slider drag → `writeBuffer` → next frame)
- [ ] Recompile path works (graph change → new pipeline → async creation → swap)
- [ ] Image textures load and render correctly (Y-flip verified)
- [ ] Pipeline cache prevents redundant compilation
- [ ] Device lost → recovery works
- [ ] RAF loop, quality tiers, DPR capping all work
- [ ] `viewer.ts` works with WebGPU backend
- [ ] Fallback to WebGL2 works when WebGPU unavailable

---

## Phase 2b — WebGPU Multi-Pass + Preview

**Goal:** Complete WebGPU coverage. Multi-pass rendering and preview thumbnails.

### Multi-pass rendering

WebGPU render passes map more naturally to Sombra's multi-pass model than WebGL FBOs:

```typescript
// Per intermediate pass: render to a texture
const intermediateTexture = this.device.createTexture({
  size: [width, height],
  format: this.canvasFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});

// Pass N reads Pass N-1's texture via bind group
const passBindGroup = this.device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: this.uniformBuffer } },
    { binding: 1, resource: previousPassTexture.createView() },
    { binding: 2, resource: this.linearSampler },
  ],
});
```

The intermediate texture cap (8 desktop, 4 mobile) transfers directly — it's a policy decision, not a WebGL limitation.

Per-pass dirty propagation also transfers directly — it's renderer-internal logic that decides which passes to re-execute.

### Preview renderer: async readback

This is the most significant architectural change. The current flow:

```
renderPreview() → readPixels() → ImageBitmap  (sync, ~2ms)
```

Becomes:

```
renderPreview() → render to texture → copy to staging buffer →
  mapAsync() → read data → ImageBitmap  (async, ~3-5ms)
```

**Strategy:** Don't try to preserve the 8ms-budget-with-4-sync-renders model. Instead:

1. Submit all preview render commands in a batch (all pending nodes)
2. Each renders to its own small texture (80x80)
3. Copy all results to a single staging buffer (or one per node)
4. Submit all commands, then `mapAsync` the staging buffer(s)
5. When mapping resolves, create all `ImageBitmap`s and update the store

This is actually more efficient — you submit a batch of GPU work and get all results back in one async round-trip instead of interleaving render→readback→render→readback.

The scheduler changes from "process up to 4 nodes synchronously within 8ms" to "submit a batch of N renders, await all results, update store." The RAF cadence stays the same — you just do the readback in the next frame's callback.

**WebGPU can use one device for both main and preview rendering.** No need for a separate context. The preview renderer creates textures on the same device and submits commands to the same queue. This is simpler than the current two-context architecture.

### Verification

- [ ] Multi-pass graphs render identically on WebGPU and WebGL2
- [ ] Per-pass dirty propagation works
- [ ] Intermediate texture cap enforced
- [ ] Node re-emission produces correct results across pass boundaries
- [ ] Preview thumbnails render correctly (async flow)
- [ ] Preview scheduler handles async readback without dropped frames
- [ ] Ping-pong equivalence verified (WebGPU uses separate textures, not ping-pong)
- [ ] Single GPUDevice serves both main and preview rendering

---

## Phase 3 — Export Pipeline & Web Component

Unchanged from v1 of the plan. The IR enables multi-target export:
- IR → GLSL for WebGL targets
- IR → WGSL for WebGPU targets
- Uniform manifest generated from IR uniform declarations
- `<sombra-shader>` Web Component with WebGPU + WebGL fallback

The runtime is a stripped-down version of the renderer — no node graph, no compilation, just: parse manifest → compile shader → wire inputs → render loop.

Now that we know there are no video/audio inputs in the current codebase, these are purely new capabilities for the export runtime (Phase 3), not migration concerns.

---

## Phase 4 — Compute Shader Nodes (Future)

Unchanged from v1. Deferred until after the core migration.

---

## Updated Risk Register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| IR doesn't cover edge cases in complex nodes (Reeded Glass, Warp) | High | Phase 1 is tiered — trivial nodes first to prove the design before tackling complex ones |
| GLSL→WGSL noise function transliteration introduces subtle visual differences | High | Per-pixel comparison tests between WebGL and WebGPU output for representative graphs |
| Async preview readback causes visible thumbnail latency | Medium | Batch submissions + single round-trip. If latency is perceptible, consider keeping WebGL preview renderer as permanent fallback (it's only 80x80) |
| WebGPU pipeline creation too slow for interactive editing | Medium | `createRenderPipelineAsync` + aggressive caching + show compilation indicator |
| WGSL `mod()` behavior differs from GLSL `mod()` | Medium | WGSL uses `%` which matches GLSL `mod()` for positive values. Test negative inputs in noise functions. |
| Node re-emission breaks with IR path | Medium | Explicit test: create a graph with cross-pass non-texture dependencies, verify both backends |
| `viewer.ts` breaks during refactor | Low | Viewer is a simple consumer — test it explicitly at each phase boundary |

---

## Sequencing & Dependencies

```
Phase 0  ──────────────────► can start immediately
Phase 1a ──► needs Phase 0 (interface defined, consumers updated)
Phase 1b ──► needs Phase 1a (IR types proven, GLSL/WGSL backends exist)
Phase 1c ──► needs Phase 1b (function registry and SRT in IR)
Phase 2a ──► needs Phase 0 + Phase 1a (interface + at least WGSL for trivial nodes)
Phase 2b ──► needs Phase 2a + Phase 1c (multi-pass needs texture sampling IR)
Phase 3  ──► needs Phase 2a (export runtime is based on the renderer)
```

Note: **Phase 2a can start as soon as Phase 1a is done** — you don't need all nodes in the IR to start rendering trivial graphs on WebGPU. This lets the rendering work and codegen work proceed in parallel if you have the bandwidth.
