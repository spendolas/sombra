# Sombra Architecture Snapshot

> **Purpose:** Phase 0 audit for the WebGPU migration. This document maps every module, data flow, resource lifecycle, and rendering concern in the current WebGL2 codebase. Section 9 ("Surprising Findings") highlights facts that will affect migration planning.

---

## 1. Module Structure

```
src/
├── stores/
│   ├── graphStore.ts         # Zustand: nodes[], edges[], undo/redo (persisted to localStorage)
│   ├── compilerStore.ts      # Zustand: vertexShader, fragmentShader, errors (not persisted)
│   ├── settingsStore.ts      # Zustand: UI layout, preview mode, autoCompile, debounceMs (persisted)
│   └── previewStore.ts       # Zustand: per-node ImageBitmaps (not persisted)
├── compiler/
│   ├── glsl-generator.ts     # Main codegen: compileGraph() -> RenderPlan (946 lines)
│   ├── topological-sort.ts   # Graph traversal: reverse DFS, cycle detection (132 lines)
│   ├── compiler.worker.ts    # Web Worker entry: dispatches compile/preview requests (71 lines)
│   ├── use-live-compiler.ts  # React hook: 3-tier update (semantic/uniform/renderer) (296 lines)
│   └── subgraph-compiler.ts  # Preview compilation: compiles subgraph to targetNode (288 lines)
├── webgl/
│   ├── renderer.ts           # WebGLRenderer: fullscreen quad, multi-pass, quality tiers (963 lines)
│   ├── preview-renderer.ts   # PreviewRenderer: offscreen 80x80, readPixels -> ImageBitmap (368 lines)
│   └── preview-scheduler.ts  # PreviewScheduler: staleness, batching, time-live re-render (312 lines)
├── nodes/
│   ├── types.ts              # NodeDefinition, GLSLContext, UniformSpec, etc.
│   ├── registry.ts           # NodeRegistry singleton
│   ├── type-coercion.ts      # Port type conversion rules
│   ├── index.ts              # ALL_NODES[] (41 nodes), initializeNodeLibrary(), bindNodeComponents()
│   ├── noise/noise-functions.ts  # Shared GLSL function registration (simplex, value, worley, box)
│   └── [category]/[node].ts  # One file per node type
├── App.tsx                   # Root layout, creates renderers, wires compiler -> renderer
├── main.tsx                  # Entry: initializeNodeLibrary() -> bindNodeComponents() -> React render
├── viewer.ts                 # Standalone viewer: decode hash -> compile -> render (no React)
└── dev-bridge.ts             # window.__sombra automation API
```

### Module boundaries at a glance

| Layer | Touches WebGL? | Migration scope |
|-------|---------------|-----------------|
| `stores/` | No | Unchanged -- pure Zustand state |
| `compiler/` | No (outputs RenderPlan) | Codegen changes (GLSL -> WGSL), Worker dispatch unchanged |
| `webgl/` | **Yes -- all 3 files** | Full replacement target |
| `nodes/` | No (GLSL strings only) | Each node's `glsl()` needs a WGSL equivalent |
| `App.tsx` | Creates renderers | Swap WebGLRenderer for WebGPU backend |
| `viewer.ts` | Creates renderer directly | Same swap, must work without React |
| `dev-bridge.ts` | No | Unchanged |

---

## 2. Data Flow: Uniform Param Change (fast path)

This is the hot path -- triggered every time a user drags a slider. No shader recompilation occurs.

```
User drags slider (updateMode='uniform')
    |
graphStore.updateNodeData() -> immutable update to node.data.params
    |
useLiveCompiler: uniformKey changed, semanticKey NOT changed
    |
setTimeout (50-300ms dynamic debounce)
    |
Fast path: reads lastUniformsRef (from previous compile)
Builds values array: [{ name: "u_abc_scale", value: 2.5 }]
    |
Calls onUniformUpdate callback
    |
WebGLRenderer.updateUniforms():
  Single-pass: gl.useProgram() -> gl.uniform1f(loc, 2.5)
  Multi-pass: routes to affected pass(es) + marks dirty [P3]
    |
requestRender() -> next RAF picks it up
    |
GPU executes same shader with new param value
```

**Migration notes:**
- WebGPU uniforms live in bind groups backed by `GPUBuffer`. The equivalent of `gl.uniform1f()` is `device.queue.writeBuffer()` into the uniform buffer.
- Multi-pass dirty propagation logic is renderer-internal and transfers directly.

---

## 3. Data Flow: Recompile (full path)

Triggered by structural graph changes (add/remove node/edge) or `updateMode='recompile'` params (enum dropdowns).

```
User changes enum dropdown (updateMode='recompile')
  OR user adds/removes node/edge
    |
graphStore.addNode/addEdge/updateNodeData -> nodes/edges arrays change
    |
useLiveCompiler: semanticKey changed
    |
setCompiling(true) -> setTimeout (50-300ms adaptive debounce)
    |
Dispatch to Web Worker: { id: UUID, nodes: [...], edges: [...] }
    |
Worker:
  compileGraph(nodes, edges):
    1. hasCycles() -> cycle check (forward DFS)
    2. topologicalSort() -> execution order (reverse DFS from Fragment Output)
    3. partitionPasses() -> single-pass or multi-pass?
       - Scans for wired textureInput ports
       - If none -> returns null -> single-pass [P1]
       - If found -> computes per-node depth -> groups by depth
    4. compileSinglePass() or compileMultiPass():
       For each node in execution order:
         generateNodeGlsl():
           - Resolve inputs (wire -> source var, default -> literal/auto_uv)
           - Resolve connectable params (wired -> source var, unwired -> uniform or literal)
           - SRT framework injection if spatial
           - Call definition.glsl(ctx) -> GLSL snippet
           - Accumulate functions, uniforms, userUniforms
       assembleFragmentShader():
           - #version 300 es header
           - uniform declarations (only used ones)
           - deduplicated function declarations
           - main() { all node GLSL snippets }
    5. Return RenderPlan { passes[], userUniforms[], isTimeLiveAtOutput, qualityTier }
    |
postMessage({ id, result: RenderPlan, durationMs })
    |
Main thread: onCompile callback
    |
compilerStore.setShaders() -> stores for debug/export
    |
WebGLRenderer.updateRenderPlan(plan):
  Single-pass: getOrCompileProgram() -> buildUniformCache() -> install
  Multi-pass: per-pass program compile, allocateFBOs(), buildDownstreamMap()
    |
render(): viewport -> useProgram -> bindTextures -> drawArrays
```

**Migration notes:**
- The Worker + `compileGraph()` pipeline is the primary codegen boundary. Swapping GLSL output for WGSL output happens inside `assembleFragmentShader()` (or its replacement).
- `updateRenderPlan()` is the renderer's main entry point. The WebGPU equivalent will create `GPURenderPipeline` objects instead of WebGL programs.
- `getOrCompileProgram()` maps to `device.createRenderPipeline()` or `device.createRenderPipelineAsync()`.

---

## 4. Resource Lifecycle

### Programs (WebGL shader programs)

- **Created** via `compileProgram()` (vertex + fragment -> link).
- **Cached** in an LRU map keyed by the full fragment source string.
  - Main renderer: max 32 programs.
  - Preview renderer: max 64 programs.
- **Evicted:** LRU entry -> `gl.deleteProgram()`.
- **Destroyed:** all deleted on `destroy()`.

### FBOs (Multi-pass only)

- **Allocated** by `allocateFBOs(count, w, h)` when a multi-pass plan arrives.
- One FBO per intermediate pass (all except last).
- **Capped** at `maxIntermediateTextures` (8 desktop, 4 mobile) [P2].
- **Resized** when canvas resizes (`resizeFBOs()` -> re-upload `texImage2D`).
- **Destroyed** on plan change or renderer destroy.

### Ping-pong FBOs (Preview only)

- 2 additional FBOs for multi-pass preview rendering.
- **Lazy allocation** -- first multi-pass preview triggers creation.
- **Destroyed** on preview renderer destroy.

### Image Textures

- Managed per sampler name in `imageTextures` Map.
- **Created** via `uploadImageTexture(samplerName, HTMLImageElement)`.
- **Flips Y** (`UNPACK_FLIP_Y_WEBGL`) for web images.
- **Replaced:** deleted and re-created on re-upload.
- **Bound** to texture units alongside FBO textures during render.
- **Destroyed:** all deleted on `destroy()`.

### VAO + VBO (Fullscreen quad geometry)

- One VAO + one VBO for the fullscreen quad (6 vertices, 2 triangles).
- **Created once** at init, never recreated except after context loss.
- **Deleted** on `destroy()`.

### Context Loss Recovery [P10]

- `webglcontextlost`: nulls all GL object refs, stops animation.
- `webglcontextrestored`: re-inits quad, re-detects GPU caps, re-compiles default shader, restarts animation.

---

## 5. Texture / Image Inputs

### Image Node (`src/nodes/input/image.ts`)

- Users upload images via the `ImageUploader` component.
- Image stored as base64 in node params (stripped from localStorage persistence).
- Sampler name: `u_${nodeId.replace('-','_')}_image`.
- Uploaded via `renderer.uploadImageTexture(samplerName, htmlImageElement)`.
- Supports spatial transforms (scale, rotate, translate) via the SRT framework.
- Has `fitMode` enum param (recompile): contain, cover, fill, tile.
- GLSL: `texture(u_image_xyz, coords)` with fit-mode UV transform.

### No video or audio inputs

No video, audio, or webcam inputs exist in the current codebase. Only static image uploads.

---

## 6. Canvas & Context Setup

### Main renderer

```
canvas.getContext('webgl2')
```

- **No explicit context attributes** -- uses browser defaults: `alpha=true`, `antialias=true`, `premultipliedAlpha=true`.
- Canvas pixel size = CSS size x DPR x `currentDprScale`.
- DPR capped at max 2.0 x quality tier scale (0.5--1.0).

### Preview renderer

```
new OffscreenCanvas(80, 80).getContext('webgl2')
```

- Fixed 80x80 size.
- Separate WebGL2 context from main -- **never in the DOM**.

### DPR & Adaptive Resolution

- `currentDprScale`: 0.5 (low) to 1.0 (high).
- Per-tier values:

| Tier | Animated DPR | Static DPR |
|------|-------------|-----------|
| adaptive | 0.75 | 1.0 |
| low | 0.5 | 0.5 |
| medium | 0.75 | 0.75 |
| high | 1.0 | 1.0 |

- **Snap-to-static:** 2-second timer after param change -- temporarily renders at static DPR (high quality), then reverts.

### Frozen `u_ref_size`

- `refSize = min(canvas.clientWidth, canvas.clientHeight)` -- frozen on first valid render.
- **Never changes after that** (resize-independent).
- Used in `auto_uv`: `(gl_FragCoord - resolution*0.5) / (dpr * ref_size) + 0.5`.

---

## 7. Quality Tiers

```typescript
type QualityTier = 'adaptive' | 'low' | 'medium' | 'high'
```

| Tier | Animated DPR | Static DPR | Target FPS |
|------|-------------|-----------|------------|
| adaptive | 0.75 | 1.0 | 30/45/60 (speed-based) |
| low | 0.5 | 0.5 | 30 |
| medium | 0.75 | 0.75 | 45 |
| high | 1.0 | 1.0 | 60 |

- Controlled by the `quality` param on the Fragment Output node (`updateMode: 'renderer'`).
- Mobile auto-downgrades `adaptive`/`high` to `medium`.
- Quality tiers **never affect codegen** -- no Worley quality toggles, no FBM octave changes. They only control resolution and frame rate.

---

## 8. RAF Loop & Animation

- `startAnimation()`: RAF loop with FPS throttling via `interval = 1000/targetFps`.
- **Frame drift correction:** `lastFrameTime = timestamp - (elapsed % interval)`.
- `setAnimated(animated)`: switches DPR scale and starts/stops the loop.
- `setAnimationSpeed(speed)`: adaptive tier adjusts FPS based on speed.
- `requestRender()`: for static graphs, queues a single RAF render.
- `isTimeLiveAtOutput`: determined at compile time by checking if `u_time` uniform is used. Controls whether the renderer enters the animation loop or stays in single-render mode.

---

## 9. Surprising Findings

These are facts discovered during the source audit that the migration plan does not explicitly account for, or that contradict assumptions. Each finding has direct implications for the abstraction layer and migration strategy.

### 9.1 Two separate WebGL contexts

The main renderer and preview renderer each create their own WebGL2 context. The preview context lives on an `OffscreenCanvas` that is never added to the DOM. The renderer abstraction interface must handle both use cases (DOM canvas and offscreen canvas), or the preview system needs its own renderer backend. WebGPU's `GPUDevice` is not tied to a canvas, which may simplify this -- a single device can render to multiple textures/canvases.

### 9.2 Preview renderer uses synchronous `readPixels`

`gl.readPixels()` is synchronous in WebGL2. The WebGPU equivalent (`buffer.mapAsync()` on a staging buffer) is **asynchronous**. This changes the preview rendering contract from:

```
renderPreview() -> ImageBitmap   // sync, current
```

to:

```
renderPreview() -> Promise<ImageBitmap>   // async, WebGPU
```

The preview scheduler's batching logic (8ms budget, 4 nodes per frame) assumes synchronous readback and will need rethinking. The budget model breaks when each readback yields back to the event loop.

### 9.3 No explicit context attributes

The main canvas uses `canvas.getContext('webgl2')` with no attributes object. This means browser defaults apply (`alpha=true`, `antialias=true`, `premultipliedAlpha=true`). WebGPU requires explicit configuration:

```typescript
context.configure({
  device,
  format: navigator.gpu.getPreferredCanvasFormat(),
  alphaMode: 'premultiplied',  // must choose explicitly
});
```

The migration must decide on alpha mode and document the choice.

### 9.4 Multi-pass is already fully functional

The migration plan asked to confirm whether multi-pass exists. It does -- a complete FBO pipeline with:

- `TextureInput` port boundaries that trigger pass partitioning
- Ping-pong buffers for preview rendering
- Per-pass dirty propagation [P3] -- only re-renders passes whose uniforms changed
- Per-pass texture filtering [P7]
- Hard cap on intermediate textures (8 desktop, 4 mobile) [P2]
- Node re-emission for cross-pass non-texture dependencies

This is significantly more complex than a simple single-pass renderer. The abstraction layer must handle FBO/render-texture allocation, inter-pass texture binding, and dirty tracking from day one.

### 9.5 `KHR_parallel_shader_compile` detected but unused

Line 187 of `renderer.ts` detects the `KHR_parallel_shader_compile` extension and stores the boolean, but it is never actually used for async compilation polling. WebGPU has `device.createRenderPipelineAsync()` built-in, making this detection moot. However, the unused detection suggests the codebase intended to add async compilation at some point -- WebGPU delivers this for free.

### 9.6 Node re-emission in multi-pass

When a later pass references a node from an earlier pass via a **non-texture edge** (e.g., a float value computed in pass 0 is needed in pass 2), that node's GLSL is re-emitted in the later pass's shader source. This is a codegen concern, not a renderer concern, but it means:

- The same node can appear in multiple passes' shader source.
- The IR must track which nodes are re-emitted and ensure their uniforms are bound in every pass that uses them.
- This behavior must be preserved in the WGSL codegen path.

### 9.7 Context loss handling exists

Full context loss/restore cycle is implemented:

- `webglcontextlost` event: nulls all GL object references, stops animation.
- `webglcontextrestored` event: re-initializes the quad, re-detects GPU caps, re-compiles the default shader, restarts animation.

WebGPU uses a `device.lost` promise instead of canvas events. The recovery pattern differs -- you must request a new device from the adapter rather than waiting for the browser to restore the context. The migration must implement the `device.lost` -> re-request flow.

### 9.8 Program cache is keyed by full fragment source

The entire GLSL source string is used as the cache key (via a `Map<string, CachedProgram>`). This works for WebGL because program compilation is relatively fast. WebGPU pipeline creation is more expensive and involves more state (vertex layout, color targets, blend state). Consider:

- Hash-based keys instead of full-source keys to reduce Map overhead.
- More aggressive caching and reuse -- pipeline creation should be deferred or async where possible.
- Pipeline layout sharing across similar shaders to reduce descriptor set costs.

### 9.9 Viewer is a separate entry point

`src/viewer.ts` is a standalone HTML page that creates its own `WebGLRenderer` directly. It uses the same renderer class but bypasses all React, Zustand, and Worker infrastructure:

```
URL hash -> decode -> compileGraph() -> WebGLRenderer -> fullscreen render
```

The renderer abstraction **must work without React**. It cannot depend on hooks, stores, or any React lifecycle. The viewer is proof that the renderer API is already framework-agnostic in spirit -- the migration should preserve this.

### 9.10 Image texture Y-flip

WebGL requires `UNPACK_FLIP_Y_WEBGL` to flip web images (which are top-down) to OpenGL's bottom-up texture coordinate system. WebGPU handles image orientation differently:

```typescript
device.queue.copyExternalImageToTexture(
  { source: imageBitmap, flipY: true },  // explicit per-copy
  { texture: gpuTexture },
  [width, height]
);
```

The `flipY` option moves from a global GL state toggle to a per-copy parameter. Every image upload callsite must pass this explicitly.

### 9.11 41 node types, not 39

`CLAUDE.md` states 39 nodes, but the actual `ALL_NODES` array in `src/nodes/index.ts` contains **41 entries**. This affects the scope of IR conversion work -- each node's `glsl()` function must gain a WGSL equivalent (or the codegen must transpile GLSL snippets automatically).

---

## Appendix: File Size Reference

These line counts indicate relative complexity and migration effort per file.

| File | Lines | Migration impact |
|------|-------|-----------------|
| `webgl/renderer.ts` | 963 | **Full replacement** -- core rendering loop, multi-pass, FBOs, uniforms |
| `compiler/glsl-generator.ts` | 946 | **Heavy modification** -- GLSL assembly becomes WGSL assembly |
| `webgl/preview-renderer.ts` | 368 | **Full replacement** -- offscreen rendering, sync readPixels |
| `webgl/preview-scheduler.ts` | 312 | **Moderate modification** -- async readback changes batching model |
| `compiler/use-live-compiler.ts` | 296 | **Light modification** -- renderer interface calls change |
| `compiler/subgraph-compiler.ts` | 288 | **Moderate modification** -- GLSL codegen for preview subgraphs |
| `compiler/topological-sort.ts` | 132 | **Unchanged** -- pure graph algorithm |
| `compiler/compiler.worker.ts` | 71 | **Light modification** -- dispatch logic stays, output format may change |
