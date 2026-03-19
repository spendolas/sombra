# Phase 6: Multi-Pass Rendering + Composable Effects

## Context

Sombra's current architecture compiles the entire node graph into a **single fragment shader**. Transform nodes (Reeded Glass, Tile, Quantize UV, Polar Coords, Domain Warp) operate on **coordinates** — they take `vec2` in and output `vec2`. This makes effects non-composable: you can't wire `Noise → Reeded Glass` because Reeded Glass wants coords, not color. UV transform chains stack in reverse order. To apply a spatial effect, you must wire it *before* the source, not after.

**Goal:** Make effects truly composable. `Noise → Reeded Glass → Dither → Output` should "just work" — each effect applies to the previous one's visual result, reading left-to-right. Spatial nodes get framework-managed SRT transforms. Scale convention flips to `1 = 100%`.

**Approach:** Multi-pass rendering with automatic texture intermediates. The compiler outputs a `RenderPlan` (ordered array of render passes) instead of a single shader. When an effect node needs to spatially sample its input (distortion, tiling, pixelation), the compiler auto-inserts a pass boundary — upstream renders to a texture, the effect node samples that texture at computed coordinates.

---

## Sprint 1: RenderPlan Infrastructure (compiler-side only)

Refactor the compiler to produce `RenderPlan` where existing single-pass graphs compile to a plan with one pass. No renderer changes yet — the renderer reads the final pass's shader.

### Type Changes (`src/nodes/types.ts`)

```typescript
// New field on PortDefinition
textureInput?: boolean  // When true + wired, triggers a pass boundary

// New field on GLSLContext
textureSamplers?: Record<string, string>  // portId → sampler2D uniform name

// New types for spatial config
interface SpatialConfig {
  transforms: Array<'scale' | 'scaleXY' | 'rotate' | 'translate'>
  order?: 'SRT' | 'TRS' | 'RST'  // default: 'SRT'
}

// New field on NodeDefinition
spatial?: SpatialConfig
```

### New Types (`src/compiler/glsl-generator.ts`)

```typescript
interface RenderPass {
  index: number
  fragmentShader: string
  vertexShader: string
  userUniforms: UniformSpec[]
  inputTextures: Map<string, number>  // samplerName → source pass index
  isTimeLive: boolean
}

interface RenderPlan {
  success: boolean
  passes: RenderPass[]
  errors: Array<{ message: string; nodeId?: string }>
  isTimeLiveAtOutput: boolean
  qualityTier: string
  // Backward compat — final pass's shader:
  fragmentShader: string
  userUniforms: UniformSpec[]
}
```

### Pass Partitioning Algorithm

1. Full topo sort from `fragment_output`
2. Walk sorted nodes. For each node, check if any input has `textureInput: true` AND is wired.
3. If so: backward-DFS from the source edge to collect all upstream nodes feeding that texture input. Those form an earlier pass.
4. The texture-consuming node + everything downstream goes in a later pass.
5. Repeat for chained texture inputs (`A → B(textureInput) → C(textureInput)` → 3 passes).
6. Single-pass graphs (no wired texture inputs) skip partitioning entirely — wrap existing result.

### Files to modify

| File | Change |
|---|---|
| `src/nodes/types.ts` | Add `textureInput`, `textureSamplers`, `SpatialConfig`, `spatial` |
| `src/compiler/glsl-generator.ts` | `compileGraph()` returns `RenderPlan`. Add pass partitioning. Per-pass codegen. Add sampler2D uniform declarations to `assembleFragmentShader()`. |
| `src/compiler/compiler.worker.ts` | Update `CompileResponse` to carry `RenderPlan` |
| `src/compiler/use-live-compiler.ts` | Update `onCompile` callback type. Extract `fragmentShader` from final pass for backward compat. |
| `src/App.tsx` | `handleCompile` reads from `RenderPlan` (initially just final pass shader) |

### Verification
- All existing graphs compile to single-pass `RenderPlan` with identical shader output
- `npm run dev` — existing test graphs render correctly
- Console: `[Sombra] Generated Fragment Shader:` output unchanged

---

## Sprint 2: Multi-Pass Renderer

Extend `WebGLRenderer` to execute multiple passes per frame using FBOs.

### Renderer Changes (`src/webgl/renderer.ts`)

New data structures:
- `PassState`: per-pass `WebGLProgram`, uniform cache, sampler bindings, `dirty` flag
- FBO pool: `WebGLFramebuffer` + `WebGLTexture` pairs for intermediate passes

New method: `updateRenderPlan(plan: RenderPlan)`
- **[P1]** Single-pass plans bypass FBO setup entirely — falls through to existing code path
- **[P6]** Check program cache by shader source hash before compiling. Only compile cache misses.
- **[P5]** If `KHR_parallel_shader_compile` available: compile async, poll in RAF, hot-swap on completion
- Allocate FBOs lazily on first multi-pass render
- **[P2]** Assign physical textures via ping-pong (2 textures for linear chains, grow for branches)
- Build `uniformName → passIndex` lookup for fast-path routing

Modified `render()`:
- **[P3]** Skip clean passes (reuse cached FBO texture from previous frame)
- Each dirty pass: bind FBO (or screen for last), use program, upload built-in uniforms, upload user uniforms, bind input textures to sampler units, draw quad, unbind
- **[P4]** Apply quality-tier resolution scaling to intermediate FBOs
- **[P7]** Set `gl.NEAREST` or `gl.LINEAR` per FBO texture based on pass hint
- Texture unit assignment: sequential from `TEXTURE0`

Modified `updateUniforms()`:
- Route each uniform to the correct pass program using `uniformName → passIndex` map
- **[P3]** Mark affected pass + downstream passes as dirty

Texture management:
- RGBA8 textures, resolution = canvas × DPR × tier scale factor
- Resize all on viewport change
- **[P2]** Hard cap: 8 intermediate textures. Warn on overflow.
- **[P10]** Context loss listeners: invalidate all GL objects, rebuild from current `RenderPlan` on restore

**[P9]** Mobile detection at init:
- Query `MAX_TEXTURE_SIZE`, `MAX_TEXTURE_IMAGE_UNITS`, `RENDERER` string
- Cap intermediate count and resolution for low-end GPUs
- Force `medium` or `low` tier if detected

Keep `updateShader()` as backward-compat wrapper creating a single-pass plan.

### Files to modify

| File | Change |
|---|---|
| `src/webgl/renderer.ts` | Major: FBO pool, multi-pass loop, per-pass programs, uniform routing |
| `src/App.tsx` | Call `renderer.updateRenderPlan(plan)` instead of `renderer.updateShader()` |
| `src/stores/compilerStore.ts` | Optionally store full `RenderPlan` |

### Verification
- Existing single-pass graphs still render correctly (the single pass renders to screen)
- Manually construct a 2-pass `RenderPlan` in dev console to test FBO pipeline
- No visual regressions in any test graph

---

## Sprint 3: Source Input on Reeded Glass (Proof of Concept)

Add a `source` (vec3) input with `textureInput: true` to Reeded Glass. Demonstrates the full multi-pass pipeline end-to-end.

### Dual-Mode Node Pattern

Reeded Glass gains:
- New input: `{ id: 'source', label: 'Source', type: 'vec3', textureInput: true }`
- New output: `{ id: 'color', label: 'Color', type: 'vec3' }` (populated when source is wired)
- Existing output: `{ id: 'coords', label: 'Coords', type: 'vec2' }` (always populated)

The `glsl()` function checks `ctx.textureSamplers?.source`:
- **Texture mode** (source wired): `texture(samplerName, distortedUV).rgb` → writes `color` output
- **Legacy mode** (source unwired): computes distorted coords → writes `coords` output (backward compatible)

### Compiler Changes for Texture Sampling

In `glsl-generator.ts`, the per-pass codegen must:
1. Detect `textureInput` port is wired
2. Partition upstream subgraph into earlier pass (Sprint 1 algorithm)
3. Generate `uniform sampler2D u_pass0_tex;` declaration in the effect pass
4. Populate `ctx.textureSamplers = { source: 'u_pass0_tex' }` when calling `glsl()`
5. `assembleFragmentShader()` emits sampler declarations

### Files to modify

| File | Change |
|---|---|
| `src/nodes/transform/reeded-glass.ts` | Add `source` input, `color` output, dual-mode `glsl()` |
| `src/compiler/glsl-generator.ts` | Sampler uniform generation, `textureSamplers` population |

### Verification
- Wire `Noise → Reeded Glass (source) → Output` — should compile to 2-pass plan and render correctly
- Wire `Reeded Glass (coords out) → Noise (coords in) → Output` — legacy mode still works
- Adjust Reeded Glass sliders — uniforms route to correct pass
- `u_time` (if noise uses Time) correctly propagates across passes

---

## Sprint 4: Framework SRT + Scale Convention Flip

### Framework SRT System

Nodes declare `spatial` config:
```typescript
// Example: Noise node
spatial: {
  transforms: ['scale', 'rotate', 'translate'],
  order: 'SRT',
}
```

The compiler auto-injects:
1. Framework-managed uniform params: `_srt_scaleX`, `_srt_scaleY`, `_srt_rotate`, `_srt_translateX`, `_srt_translateY` (prefixed to avoid collision with node params)
2. GLSL before `node.glsl()`:
   ```glsl
   // Framework SRT transform
   vec2 srt_coords = coords - 0.5;          // center
   srt_coords /= vec2(scaleX, scaleY);      // scale (1/scale for flipped convention)
   float c = cos(rotate); float s = sin(rotate);
   srt_coords = mat2(c, -s, s, c) * srt_coords;  // rotate
   srt_coords += vec2(translateX, translateY);      // translate
   srt_coords += 0.5;                              // re-center
   ```
3. Replaces `coords` in `ctx.inputs` with the transformed variable

Nodes that adopt framework SRT **remove** their manual scale/rotate/translate params.

### Scale Convention Flip

`scale = 1` → natural size (100%). `scale = 2` → twice as large. Internally: `coords /= scale` instead of `coords *= scale`.

### Nodes to Update

| Node | Current manual params to remove | Spatial config |
|---|---|---|
| `noise.ts` | `scale` (connectable) | `{ transforms: ['scale', 'translate'] }` |
| `fbm.ts` | `scale` (connectable) | `{ transforms: ['scale', 'translate'] }` |
| `domain-warp.ts` | `scale` (connectable) | `{ transforms: ['scale', 'translate'] }` |
| `uv-coords.ts` | `scaleX, scaleY, rotate, offsetX, offsetY` | `{ transforms: ['scaleXY', 'rotate', 'translate'] }` |
| `checkerboard.ts` | `scale` | `{ transforms: ['scale', 'rotate', 'translate'] }` |
| `stripes.ts` | `frequency` (conceptually scale) | `{ transforms: ['scale', 'rotate', 'translate'] }` |
| `dots.ts` | `scale` | `{ transforms: ['scale', 'rotate', 'translate'] }` |
| `reeded-glass.ts` | — (no manual SRT currently) | `{ transforms: ['scale', 'rotate', 'translate'] }` |

### Backward Compatibility

- Bump `SOMBRA_FILE_VERSION` to `2` in `src/utils/sombra-file.ts`
- Add v1→v2 migration: invert `scale` values (`newScale = 1/oldScale`) for affected params, remap old param IDs to new `_srt_*` framework param IDs
- v1 files auto-migrate on load

### Files to modify

| File | Change |
|---|---|
| `src/compiler/glsl-generator.ts` | SRT GLSL injection before `node.glsl()`, framework uniform generation |
| `src/nodes/noise/noise.ts` | Add `spatial`, remove `scale` param |
| `src/nodes/noise/fbm.ts` | Add `spatial`, remove `scale` param |
| `src/nodes/noise/domain-warp.ts` | Add `spatial`, remove `scale` param |
| `src/nodes/input/uv-coords.ts` | Add `spatial`, remove SRT params |
| `src/nodes/pattern/checkerboard.ts` | Add `spatial`, remove `scale` |
| `src/nodes/pattern/stripes.ts` | Add `spatial`, remove `frequency` (replace with scale) |
| `src/nodes/pattern/dots.ts` | Add `spatial`, remove `scale` |
| `src/nodes/transform/reeded-glass.ts` | Add `spatial` |
| `src/utils/sombra-file.ts` | Version bump, v1→v2 migration |
| `src/components/ShaderNode.tsx` | Render framework SRT params in a "Transform" section |

### Verification
- Noise at `scale=1` fills the canvas. `scale=2` is twice as large. `scale=0.5` tiles 2x.
- Existing .sombra v1 files load with auto-migrated scale values and look identical
- Framework SRT params appear in node UI, respond to slider changes via uniform fast-path

---

## Sprint 5: Source Input on Remaining Transform Nodes

Apply the dual-mode pattern from Sprint 3 to all transform nodes:

| Node | New `source` input | New `color` output | Notes |
|---|---|---|---|
| `tile.ts` | `vec3, textureInput: true` | `vec3` | Texture mode: sample at tiled coords |
| `polar-coords.ts` | `vec3, textureInput: true` | `vec3` | Texture mode: sample at polar-mapped coords |
| `quantize-uv.ts` | `vec3, textureInput: true` | `vec3` | Texture mode: sample at quantized coords (pixelation) |
| `domain-warp.ts` | `vec3, textureInput: true` | `vec3` | Texture mode: sample at warped coords |

Each node follows the same pattern: check `ctx.textureSamplers?.source`, emit `texture()` call or coords.

### Verification
- `Noise → Tile (source) → Output` — tiled noise image (2 passes)
- `Noise → Quantize UV (source) → Output` — pixelated noise (2 passes)
- `Noise → Reeded Glass → Tile → Output` — 3 passes, effects chain correctly
- All nodes still work in legacy coords mode when source is unwired

---

## Sprint 6: Multi-Pass Preview System

Update the preview system to handle multi-pass nodes, with performance guardrails.

### Changes

- `src/compiler/subgraph-compiler.ts` — `compileNodePreview()` returns a mini `RenderPlan` (array of passes) when the target node or its dependencies have texture inputs. Same pass partitioning as the main compiler.
- `src/webgl/preview-renderer.ts` — `renderPreview()` accepts `RenderPass[]`. For multi-pass: allocate temp FBOs at 80×80, render each pass in sequence, read pixels from final pass. Program cache shared across preview renders (existing pattern).
- `src/webgl/preview-scheduler.ts` — Handle multi-pass preview results from worker.
- `src/compiler/compiler.worker.ts` — Update `PreviewResponse` type.

### Performance Guardrails ([P8])

- **Throttle**: Multi-pass previews use 200ms minimum interval (double the single-pass 100ms)
- **Depth limit**: For chains deeper than 3 passes, show a static gradient placeholder (no render)
- **Priority**: Visible nodes (in viewport) render before off-screen nodes. The scheduler checks node viewport intersection before queuing.
- **Shared FBOs**: Preview renderer reuses a single pair of 80×80 FBO textures (ping-pong) across all multi-pass preview renders — no per-node allocation.

### Verification
- Node thumbnails render correctly for nodes in multi-pass chains
- Preview of Reeded Glass with source wired shows the distorted image, not just coords
- Deep chains (4+ passes) show placeholder without GPU stall
- Preview rendering doesn't noticeably impact main canvas frame rate

---

## Sprint 7: Three-Tier Updates for Multi-Pass

Ensure the uniform fast-path correctly routes updates across passes.

### Changes

- `src/webgl/renderer.ts` — At `updateRenderPlan()` time, build `uniformName → { passIndex, program }` lookup. `updateUniforms()` routes each uniform to correct pass program using this map.
- `src/compiler/use-live-compiler.ts` — The `onUniformUpdate` callback sends `{ name, value, passIndex? }` tuples. Or simpler: the renderer handles routing internally since uniform names are globally unique.

### Verification
- Adjust a slider on a node in pass 1 — only that pass's uniform updates (no recompile)
- Adjust a slider on a node in pass 2 — only that pass's uniform updates
- `semanticKey` change (rewire an edge) triggers full recompile of all passes
- Animation speed/quality tier changes propagate to all passes

---

## Performance Optimization

Multi-pass rendering multiplies GPU work per frame. Every optimization here is critical for smooth browser experience, especially on mobile/integrated GPUs.

### P1: Single-Pass Fast Path (Zero Overhead)

When no `textureInput` port is wired anywhere in the graph, the entire multi-pass system must be **completely inert** — no FBO allocation, no texture binding, no extra state. The `RenderPlan` has exactly one pass and the renderer executes it identically to the current single-program path.

Implementation: `renderer.updateRenderPlan(plan)` checks `plan.passes.length === 1`. If so, falls through to the existing `updateShader()` code path. No FBO setup, no pool initialization.

### P2: FBO Ping-Pong (Minimize Texture Count)

A chain `A → B(tex) → C(tex) → Output` does NOT need 3 textures. It needs only **2** (ping-pong):
- Pass 1 renders to Tex A
- Pass 2 reads Tex A, renders to Tex B
- Pass 3 reads Tex B, renders to screen

Only branching graphs (two sources merge into one node) need more than 2. The compiler annotates each pass with which previous pass textures it reads, and the renderer assigns physical textures using a graph-coloring / LRU approach.

**Budget**: Hard cap of **8 intermediate textures**. If the graph requires more, show a console warning and degrade (skip previews, reduce resolution).

### P3: Selective Pass Re-rendering

When a uniform slider changes, only re-render **the affected pass and its downstream dependents**. Upstream passes whose uniforms haven't changed can **reuse their cached texture** from the previous frame.

Implementation:
- Each `PassState` tracks a `dirty` flag
- `updateUniforms()` marks the owning pass + all downstream passes as dirty
- `render()` skips clean passes (their FBO texture is still valid)
- Structural changes (`semanticKey`) mark all passes dirty

This is the single biggest win for interactive performance — slider tweaks on a downstream effect re-render only 1 pass instead of all.

### P4: Intermediate Resolution Scaling

Intermediate textures don't always need full canvas resolution. Apply quality tier scaling:

| Tier | Intermediate Resolution | Final Pass |
|---|---|---|
| `adaptive` (animated) | 0.75× canvas | 0.75× canvas |
| `adaptive` (static snap) | 1.0× canvas | 1.0× canvas |
| `low` | 0.5× canvas | 0.5× canvas |
| `medium` | 0.75× canvas | 0.75× canvas |
| `high` | 1.0× canvas | 1.0× canvas |

This means a 3-pass chain at `low` quality on 1920×1080@2x uses ~4MB per intermediate instead of ~16MB.

Per-node resolution override (`RenderPass.resolution`) is supported in the data structure but not exposed in UI until Phase 2.

### P5: Async Shader Compilation

WebGL2 supports `KHR_parallel_shader_compile` (Chrome 76+, Firefox 110+, Safari 16.4+). When available:
- Call `gl.compileShader()` and `gl.linkProgram()` without blocking
- Poll `gl.getShaderParameter(shader, gl.COMPLETION_STATUS_KHR)` each frame
- While compiling: keep rendering with the previous program
- On completion: hot-swap the program

Implementation in `updateRenderPlan()`:
1. Check `gl.getExtension('KHR_parallel_shader_compile')`
2. If available: compile all pass shaders, return immediately, poll in RAF loop
3. If not available: compile synchronously (current behavior)

This eliminates jank from shader compilation on structural changes.

### P6: Program Cache

Cache compiled `WebGLProgram` objects by **fragment shader source hash** (vertex shader is always the same). When a graph change only affects one pass, only that pass needs recompilation — other passes reuse their cached program.

Implementation:
- `programCache: Map<string, WebGLProgram>` (same pattern as `preview-renderer.ts` line 32)
- LRU eviction at 32 entries
- On `updateRenderPlan()`: for each pass, check cache by shader source. Cache hit → reuse program. Cache miss → compile new.

### P7: Texture Filtering Per-Pass

Not all intermediate textures need the same sampling:
- Smooth distortion effects (Reeded Glass, Domain Warp): `gl.LINEAR` filtering — smooth interpolation
- Pixelation effects (Quantize UV, Tile at integer counts): `gl.NEAREST` filtering — crisp pixels, cheaper sampling

The `RenderPass` type includes an optional `textureFilter?: 'linear' | 'nearest'` field. The renderer applies `gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, ...)` when binding each FBO texture.

### P8: Preview System Throttling

Multi-pass previews are N× more expensive than single-pass. Strategies:

1. **Throttle multi-pass previews**: 200ms minimum interval (vs 100ms for single-pass)
2. **Priority queue**: Previews for visible nodes (in viewport) render before off-screen nodes
3. **Depth limit**: For chains deeper than 3 passes, show a gradient placeholder thumbnail instead of rendering all passes
4. **Reuse main renderer textures**: If the main renderer already rendered pass 1, the preview for a pass-2 node can read that texture instead of re-rendering pass 1 at 80×80. This requires the main renderer to expose its FBO textures.

### P9: Mobile / Low-End Detection

At renderer init, query GPU capabilities:
```typescript
const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
const maxTexUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)
const renderer = gl.getParameter(gl.RENDERER)  // e.g., "Mali-G78", "Apple GPU"
```

Heuristics:
- If `maxTexSize < 4096` or vendor string contains mobile GPU names → force `medium` or `low` tier
- If `maxTexUnits < 8` → cap max intermediate textures at 4
- Cap intermediate texture resolution at `maxTexSize / 2` to leave headroom

### P10: Context Loss Recovery

WebGL contexts can be lost (GPU reset, power management, tab backgrounding).

```typescript
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault()  // Allow restoration
  stopAnimation()
  // Nullify all GL objects — they're invalid now
})

canvas.addEventListener('webglcontextrestored', () => {
  // Recreate: VAO, quad buffer, FBO pool, all programs
  // Re-upload all uniforms
  // Resume animation
})
```

The FBO pool, program cache, and uniform locations are all invalidated on context loss. The `WebGLRenderer.restore()` method rebuilds everything from the current `RenderPlan`.

### P11: Pass Merging (Compiler Optimization)

The compiler already only inserts pass boundaries at `textureInput` ports. This means consecutive non-spatial nodes (Brightness → Invert → Color Ramp) naturally merge into a single pass. No additional optimization needed — the pass partitioning algorithm handles this correctly.

However, verify that the algorithm doesn't create **unnecessary passes** for branching graphs. Example: `Noise → Mix ← Color Constant`. Both inputs to Mix are in the same pass — no boundary needed even though there are two inputs. Only `textureInput: true` ports trigger boundaries.

---

## Cross-Cutting Concerns

### Backward Compatibility
- v1 `.sombra` files with no `textureInput` ports → compile to single-pass plans. No migration needed except scale values.
- Adding `source` input to existing nodes doesn't break saved graphs — the port is simply unwired, triggering legacy coords mode.
- `CompilationResult` → `RenderPlan` transition: keep `fragmentShader` field on plan pointing to final pass shader.

### Edge Cases
- **Source unwired**: Legacy coords mode. `textureSamplers` absent. `glsl()` emits coords output.
- **Cyclic texture deps**: Impossible — texture inputs enforce strict pass ordering. Cycles already detected.
- **Multiple texture inputs on one node**: Each wired `textureInput` produces its own upstream pass. Future node (e.g., blend/composite) could have two texture inputs from different sources.
- **Chain of texture-consuming nodes**: Each boundary creates a new pass. `A → B(tex) → C(tex)` = 3 passes.

---

## File Impact Summary

| File | Sprint | Scope |
|---|---|---|
| `src/nodes/types.ts` | 1 | Add textureInput, textureSamplers, SpatialConfig, spatial |
| `src/compiler/glsl-generator.ts` | 1,3,4 | Major: RenderPlan, pass partitioning, SRT injection, sampler generation |
| `src/compiler/compiler.worker.ts` | 1 | Update message types |
| `src/compiler/use-live-compiler.ts` | 1,7 | Handle RenderPlan, uniform routing |
| `src/compiler/subgraph-compiler.ts` | 6 | Multi-pass subgraph compilation |
| `src/webgl/renderer.ts` | 2,7 | Major: FBO pool, multi-pass loop, uniform routing |
| `src/webgl/preview-renderer.ts` | 6 | Multi-pass preview rendering |
| `src/webgl/preview-scheduler.ts` | 6 | Handle multi-pass results |
| `src/nodes/transform/reeded-glass.ts` | 3,4 | Source input, dual-mode glsl(), spatial config |
| `src/nodes/transform/tile.ts` | 5 | Source input, dual-mode glsl() |
| `src/nodes/transform/polar-coords.ts` | 5 | Source input, dual-mode glsl() |
| `src/nodes/postprocess/quantize-uv.ts` | 5 | Source input, dual-mode glsl() |
| `src/nodes/noise/domain-warp.ts` | 4,5 | Spatial config, source input |
| `src/nodes/noise/noise.ts` | 4 | Spatial config, remove manual scale |
| `src/nodes/noise/fbm.ts` | 4 | Spatial config, remove manual scale |
| `src/nodes/pattern/*.ts` | 4 | Spatial config, remove manual scale |
| `src/nodes/input/uv-coords.ts` | 4 | Spatial config, remove manual SRT params |
| `src/utils/sombra-file.ts` | 4 | Version bump, v1→v2 migration |
| `src/components/ShaderNode.tsx` | 4 | Render framework SRT section |
| `src/App.tsx` | 1,2 | Handle RenderPlan, call updateRenderPlan() |
| `src/stores/compilerStore.ts` | 1 | Store RenderPlan |
