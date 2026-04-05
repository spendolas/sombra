# Codegen Pipeline Audit -- WebGPU Migration Phase 0

Full path from node graph to running shader. Every stage that must be
ported or replaced when moving from WebGL2/GLSL ES 3.0 to WebGPU/WGSL.

---

## Table of Contents

1. [Data Flow Overview](#1-data-flow-overview)
2. [Graph Traversal](#2-graph-traversal)
3. [Node-to-GLSL Codegen Pattern](#3-node-to-glsl-codegen-pattern)
4. [Function Deduplication](#4-function-deduplication)
5. [Uniform Handling](#5-uniform-handling)
6. [Web Worker Boundary](#6-web-worker-boundary)
7. [Multi-Pass Compilation](#7-multi-pass-compilation)
8. [SRT Framework Injection](#8-srt-framework-injection)
9. [Type Coercion](#9-type-coercion)
10. [Node Type Inventory](#10-node-type-inventory)

---

## 1. Data Flow Overview

```
React Flow Graph (Zustand graphStore)
    |
    v
useLiveCompiler hook
    - Derives semanticKey / uniformKey / rendererKey from node params
    - semanticKey change  --> full Worker recompile (debounced 50-300ms)
    - uniformKey change   --> fast path on main thread (uniform upload only)
    - rendererKey change  --> instant renderer state update (no GPU work)
    |
    v
Web Worker (compiler.worker.ts)
    - initializeNodeLibrary() once on Worker init (41 node types)
    - Receives { id, nodes[], edges[] }
    - Calls compileGraph() --> returns RenderPlan
    |
    v
compileGraph() in glsl-generator.ts
    - hasCycles() guard
    - topologicalSort() from Fragment Output backward
    - partitionPasses() --> null for single-pass, string[][] for multi-pass
    - compileSinglePass() or compileMultiPass()
    - Returns RenderPlan { passes[], userUniforms[], isTimeLiveAtOutput }
    |
    v
WebGLRenderer.updateRenderPlan()
    - Compiles GLSL program(s) via WebGL2 API
    - Sets up FBOs for multi-pass chains
    - Uploads uniforms
    |
    v
GPU (render loop)
    - Fullscreen quad (2 triangles, clip space -1 to 1)
    - Fragment shader does all the work
```

### Key files

| File | Lines | Role |
|------|-------|------|
| `src/compiler/topological-sort.ts` | 132 | Reverse DFS + cycle detection |
| `src/compiler/glsl-generator.ts` | 946 | Pass partitioning, per-node codegen, shader assembly |
| `src/compiler/use-live-compiler.ts` | 296 | Three-tier update dispatch (semantic/uniform/renderer) |
| `src/compiler/compiler.worker.ts` | 71 | Worker message handler |
| `src/compiler/subgraph-compiler.ts` | ~170 | Per-node preview compilation (reuses generateNodeGlsl) |
| `src/nodes/types.ts` | 256 | NodeDefinition, GLSLContext, UniformSpec, addFunction |
| `src/nodes/type-coercion.ts` | 150 | Coercion rules and coerceType() |

---

## 2. Graph Traversal

**File:** `src/compiler/topological-sort.ts`

### Algorithm: Reverse DFS from Fragment Output

1. Find the single `fragment_output` node (exactly 1 required; error on 0 or 2+).
2. Build incoming-edge adjacency map: `target --> source[]`.
3. DFS `visit(nodeId)`:
   - Skip if already visited.
   - Recursively visit all source nodes that feed into this node.
   - Append this node (post-order).
4. Result: dependencies-first order. Fragment Output is **last**.

Only nodes reachable from the output node are included. Disconnected subgraphs
are pruned.

### Cycle Detection

Separate function `hasCycles()` using forward DFS with gray/black coloring
(visiting/visited sets). Called as a guard before compilation -- cycles produce
an error plan, not a crash.

### Migration notes

- Algorithm is graph-topology only -- no GLSL dependency. Portable as-is.
- `topologicalSort()` accepts an optional `startNodeId` for preview subgraph compilation.

---

## 3. Node-to-GLSL Codegen Pattern

**File:** `src/compiler/glsl-generator.ts`, function `generateNodeGlsl()` (lines 330-552)

Each node type has a `glsl(ctx: GLSLContext) => string` function that returns a
GLSL code snippet. The compiler calls it once per node in execution order.

### GLSLContext interface

```typescript
interface GLSLContext {
  nodeId: string                           // React Flow node ID
  inputs: Record<string, string>           // port ID --> GLSL variable name or expression
  outputs: Record<string, string>          // port ID --> GLSL variable name to declare
  params: Record<string, unknown>          // current parameter values
  uniforms: Set<string>                    // standard uniforms to declare (u_time, etc.)
  functions: string[]                      // (legacy, unused)
  functionRegistry: Map<string, string>    // dedup key --> GLSL function body
  textureSamplers?: Record<string, string> // portId --> sampler2D name (multi-pass)
  imageSamplers?: Set<string>              // image node sampler names
}
```

### Per-node codegen steps (inside generateNodeGlsl)

**Step 1 -- Resolve inputs** (lines 371-416):

| Source | Resolution |
|--------|-----------|
| Wired edge | `node_${sanitizedSourceId}_${portId}` (with type coercion if needed) |
| Unconnected `auto_uv` | Inline frozen-ref UV: `(vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * 0.5) / (u_dpr * u_ref_size) + 0.5` |
| Unconnected `screen_uv` | `v_uv` (raw 0-1 from vertex shader) |
| Unconnected `auto_fragcoord` | `gl_FragCoord.xy` |
| Literal default | `formatDefaultValue()` (e.g., `0.0`, `vec3(0.5, 0.5, 0.5)`) |
| Texture boundary | Uses sampler from `textureSamplers` map |

In texture mode (multi-pass with wired textureInput), unconnected `auto_uv` inputs
are replaced with `v_uv` to stay within FBO bounds.

**Step 2 -- Resolve connectable params** (lines 419-452):

| State | Resolution |
|-------|-----------|
| Wired | Source node's output variable (with type coercion) |
| Unwired, `updateMode: 'uniform'` | Emits `uniform float u_nodeId_paramId;` + adds to userUniforms |
| Unwired, `updateMode: 'recompile'` | Bakes literal value into GLSL source |

**Step 3 -- Non-connectable uniform params** (lines 456-469):

Always emits a uniform declaration and adds to userUniforms.

**Step 4 -- SRT framework injection** (lines 472-516):

If `definition.spatial` is set, transforms the `coords` input. See [Section 8](#8-srt-framework-injection).

**Step 5 -- Call `definition.glsl(context)`** (line 538):

Returns the node's GLSL code snippet.

**Step 6 -- Wrap with comment header and preamble lines** (lines 539-543).

### Variable naming convention

```
node_${sanitizedNodeId}_${portId}
```

Where `sanitizedNodeId = nodeId.replace(/-/g, '_')`.

Intermediate per-node variables use a per-node prefix to avoid collisions:
`cb_c_${id}`, `pg_px_${id}`, `rg_wm_${id}`, etc.

### Representative examples

**Pure arithmetic (Arithmetic node):**
```glsl
// input: two wired floats
float node_arith_abc_result = node_noise_xyz_value + 0.5;
```

**Single function call (Trig node):**
```glsl
float node_trig_abc_result = sin(node_time_xyz_time * u_trig_abc_frequency) * u_trig_abc_amplitude;
```

**Function registration + call (Noise node):**
```glsl
// Registers snoise3d_01() and dependencies via addFunction()
vec2 n_soff_noise_abc = fract(vec2(u_noise_abc_seed) * vec2(12.9898, 78.233)) * 1000.0;
vec2 n_sc_noise_abc = srt_noise_abc + n_soff_noise_abc;
float node_noise_abc_value = snoise3d_01(vec3(n_sc_noise_abc, 0.0));
```

**Multi-line with texture sampling (Pixelate node, texture mode):**
```glsl
vec2 pxl_cell_pix_abc = floor(gl_FragCoord.xy / vec2(u_pix_abc_pixelSize));
vec2 node_pix_abc_uv = (pxl_cell_pix_abc + 0.5) * vec2(u_pix_abc_pixelSize) / u_viewport;
vec3 node_pix_abc_color = texture(u_pass0_tex, node_pix_abc_uv).rgb;
```

**Color Ramp (data-driven codegen):**
```glsl
// N stops baked at compile time (recompile-mode param)
vec3 node_ramp_abc_color = vec3(0.0, 0.0, 0.0);
node_ramp_abc_color = mix(node_ramp_abc_color, vec3(0.2, 0.4, 1.0), smoothstep(0.0, 0.3, node_noise_xyz_value));
node_ramp_abc_color = mix(node_ramp_abc_color, vec3(1.0, 0.8, 0.0), smoothstep(0.3, 1.0, node_noise_xyz_value));
```

---

## 4. Function Deduplication

**File:** `src/nodes/types.ts`, `addFunction()` (lines 143-147)

```typescript
function addFunction(ctx: GLSLContext, key: string, code: string): void {
  if (!ctx.functionRegistry.has(key)) {
    ctx.functionRegistry.set(key, code)
  }
}
```

Content-addressed keys ensure each GLSL function is emitted exactly once, even
when called by multiple nodes. The `functionRegistry` is a `Map<string, string>`
on the shared `GLSLContext`.

### Key naming patterns

| Key | Registered by | Content |
|-----|--------------|---------|
| `mod289_vec3` | Simplex noise | Helper for simplex permutation |
| `permute_vec4` | Simplex noise | Permutation polynomial |
| `taylorInvSqrt` | Simplex noise | Fast inverse sqrt approximation |
| `snoise3d` | Simplex noise | Raw simplex noise (-1 to 1) |
| `snoise3d_01` | Simplex noise | Remapped simplex (0 to 1) |
| `hash3` | Value noise | Hash function for value noise |
| `vnoise3d` | Value noise | Trilinear interpolated 3D value noise |
| `hash3to3` | Worley noise | 3D cell hash for Worley |
| `worley3d` | Worley noise | 3D Worley distance (27-cell) |
| `worley3d_fast` | Worley fast | 3D Worley distance (8-cell) |
| `worley2d` | Worley 2D | 2D Worley with phase animation |
| `boxnoise3d` | Box noise | Quantized value noise |
| `fbm_standard_simplex` | FBM node | FBM accumulator for standard+simplex |
| `fbm_turbulence_value` | FBM node | FBM accumulator for turbulence+value |
| `fbm_ridged_worley` | FBM node | FBM accumulator for ridged+worley |
| `hsv2rgb` | HSV to RGB | Color space conversion |
| `bayer8x8` | Dither node | 8x8 Bayer matrix (bit-interleave) |
| `sdf_circle` | Dither node | Circle SDF |
| `sdf_diamond` | Dither node | Diamond SDF |
| `sdf_triangle` | Dither node | Triangle SDF |
| `reedLens` | Reeded Glass | Cylindrical lens refraction |
| `reedHash` | Reeded Glass | Integer hash for frost jitter |

FBM keys are composite: `fbm_${fractalMode}_${noiseType}`. Different FBM
instances with the same mode+type share one function; different combos each get
their own.

### Assembly

All registered functions are emitted in `assembleFragmentShader()`:

```glsl
// Between uniform declarations and void main():
${[...functionRegistry.values(), ...functions].join('\n\n')}
```

### Migration notes

- The registry mechanism is API-agnostic. For WGSL, the same Map strategy works
  with WGSL function bodies instead of GLSL.
- Noise functions are the heaviest (~100 lines for simplex alone). These must be
  transliterated to WGSL.

---

## 5. Uniform Handling

**File:** `src/nodes/types.ts` (NodeParameter.updateMode), `src/compiler/use-live-compiler.ts`

### Three update tiers

| Tier | `updateMode` | In GLSL | Runtime path | Latency | Example params |
|------|-------------|---------|-------------|---------|---------------|
| **Semantic** | `'recompile'` | Baked literal: `float x = 4.0;` | Full Worker recompile | 50-300ms debounce | `noiseType`, `operation`, `inputCount`, `octaves`, `interpolation`, `shape`, `fitMode`, `mirror`, `direction`, `ribType`, `stops` |
| **Uniform** | `'uniform'` | Uniform decl: `uniform float u_abc_scale;` | `gl.uniform1f(loc, val)` on main thread | 50-300ms debounce (uniform-only path) | `scale`, `strength`, `frequency`, `amplitude`, `gain`, `lacunarity`, `seed`, `pixelSize`, `ribWidth`, `ior`, `curvature`, `frost` |
| **Renderer** | `'renderer'` | Not in GLSL | Renderer state only (FPS, DPR) | Instant, no debounce | `quality` (on Fragment Output) |

### UniformSpec

```typescript
interface UniformSpec {
  name: string        // "u_fbm_abc123_lacunarity"
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  value: number | number[]
  nodeId: string      // React Flow node ID (unsanitized)
  paramId: string     // NodeParameter.id
}
```

### Uniform naming

```
u_${sanitizedNodeId}_${paramId}
```

Example: `u_fbm_abc123_lacunarity`, `u_noise_xyz_seed`.

### Three-tier dispatch logic (use-live-compiler.ts)

The hook derives three memo keys:

- **semanticKey**: node IDs + types + recompile-mode param values + all edges
- **uniformKey**: uniform-mode param values only
- **rendererKey**: renderer-mode param values only

Dispatch effect (lines 207-295):

1. **rendererKey changed (only)**: Instant call to `onRendererUpdate()`. No recompile.
2. **semanticKey changed**: Debounced Worker postMessage. Dynamic debounce: `clamp(lastDuration * 0.8, 50, 300)`.
3. **uniformKey changed (only)**: Debounced main-thread fast path. Reads `lastUniformsRef`, resolves current values from node params, calls `onUniformUpdate()`.

Request ID cancellation: `currentCompileId.current` tracks latest compile. Stale Worker responses with wrong ID are discarded.

### Standard uniforms

Declared on demand (only when a node adds them to `uniforms` Set):

| Uniform | Type | Source |
|---------|------|--------|
| `u_time` | `float` | Animation time (seconds) |
| `u_resolution` | `vec2` | Canvas pixel dimensions |
| `u_mouse` | `vec2` | Mouse position (normalized) |
| `u_ref_size` | `float` | Frozen `min(width, height)` for stable sizing |
| `u_dpr` | `float` | Device pixel ratio |
| `u_viewport` | `vec2` | Render target dimensions (may differ from u_resolution in multi-pass) |

### Migration notes

- Uniform tier system is API-agnostic. WebGPU equivalent: bind group updates
  instead of `gl.uniform*` calls.
- Standard uniforms map directly to a WGSL uniform struct.
- The fast-path uniform upload avoids recompilation. WebGPU equivalent: buffer
  write to a mapped uniform buffer, no pipeline recreation.

---

## 6. Web Worker Boundary

**File:** `src/compiler/compiler.worker.ts` (71 lines)

### Worker initialization

```typescript
initializeNodeLibrary()  // Registers all 41 node types once
```

No DOM, no WebGL, no React. Pure JS only. The Worker has its own copy of the
node registry populated at startup.

### Message protocol

**Request (main --> Worker):**

Full graph compile:
```typescript
{ id: string, nodes: Node[], edges: Edge[] }
```

Preview compile:
```typescript
{ type: 'preview', id: string, targetNodeId: string, nodes: Node[], edges: Edge[] }
```

**Response (Worker --> main):**

Full graph:
```typescript
{ id: string, result?: RenderPlan, error?: string, durationMs: number }
```

Preview:
```typescript
{ type: 'preview', id: string, targetNodeId: string, result?: PreviewCompilationResult, error?: string }
```

### Data serialization

`nodes` and `edges` are plain objects (React Flow Node/Edge types) -- they
serialize cleanly via structured clone. No functions cross the boundary; all node
`glsl()` functions are registered inside the Worker via `initializeNodeLibrary()`.

### RenderPlan (output type)

```typescript
interface RenderPlan {
  success: boolean
  passes: RenderPass[]       // Array of per-pass shaders + uniforms
  errors: Array<{ message: string; nodeId?: string }>
  isTimeLiveAtOutput: boolean
  qualityTier: string
  // Backward compat:
  vertexShader: string       // Final pass vertex shader
  fragmentShader: string     // Final pass fragment shader
  userUniforms: UniformSpec[]
}

interface RenderPass {
  index: number
  fragmentShader: string
  vertexShader: string
  userUniforms: UniformSpec[]
  inputTextures: Record<string, number>  // samplerName --> source pass index
  isTimeLive: boolean
  textureFilter?: 'linear' | 'nearest'
}
```

### Migration notes

- Worker boundary is clean: structured-clone-safe data in, shader strings + metadata out.
- Replace GLSL string output with WGSL string output. RenderPlan shape stays the same.
- `durationMs` timing useful for adaptive debounce -- keep it.

---

## 7. Multi-Pass Compilation

**File:** `src/compiler/glsl-generator.ts`

Multi-pass is triggered by `textureInput` ports. When a node's input is marked
`textureInput: true` and is wired, the source subgraph renders to an FBO, and
the consuming node samples it as a `sampler2D`.

### Pass partitioning (`partitionPasses`, lines 100-174)

1. **Quick check**: Any wired `textureInput`? If not, return `null` (single-pass fast path, [P1]).
2. **Depth computation**: For each node in execution order:
   - Normal input wired: `depth = max(depth, sourceDepth)`
   - `textureInput` wired: `depth = max(depth, sourceDepth + 1)`
   - Connectable params: same-pass (not texture inputs)
3. **Grouping**: Nodes grouped by depth, preserving execution order within each group.

### Texture boundaries (`findTextureBoundaries`, lines 190-231)

For each texture boundary edge:
```typescript
{ consumerId, consumingPortId, sourcePassIndex, samplerName: "u_pass0_tex" }
```

Sampler names are sequential: `u_pass0_tex`, `u_pass1_tex`, etc.

### Multi-pass codegen (`compileMultiPass`, lines 660-830)

Per pass:
1. Collect nodes in this depth group.
2. Identify cross-pass non-texture dependencies (nodes from earlier passes
   referenced via normal edges). These are **re-emitted** in this pass's shader
   (transitive closure via BFS).
3. Generate GLSL for each node (re-emitted + pass nodes).
4. Intermediate passes: append `fragColor = ...` assignment converting the pass
   output to vec4 via `outputTypeToFragColor()`.
5. Assemble fragment shader with texture sampler declarations.
6. Record `textureFilter` hint for FBO (`'nearest'` preserves hard edges for
   Pixelate).

### Nodes with textureInput ports

| Node | textureInput port | textureFilter | Purpose |
|------|------------------|---------------|---------|
| `pixelate` | `source` (vec3) | `nearest` | Snap to pixel grid, sample from FBO |
| `warp` | `source` (vec3) | -- | Distort coordinates, sample from FBO |
| `reeded_glass` | `source` (vec3) | -- | Lens distortion, sample from FBO |
| `polar_coords` | `source` (vec3) | -- | Coordinate transform, sample from FBO |
| `tile` | `source` (vec3) | -- | Tiled UV, sample from FBO |

### Migration notes

- Multi-pass architecture maps to WebGPU render passes with texture attachments.
- FBO management becomes render pass descriptor + texture views.
- `textureFilter` hint maps to sampler descriptor `minFilter`/`magFilter`.
- Re-emission of earlier-pass nodes is a codegen concern, not a GPU concern.

---

## 8. SRT Framework Injection

**File:** `src/compiler/glsl-generator.ts`, lines 472-516

Nodes with a `spatial` config get automatic Scale-Rotate-Translate transforms
on their `coords` input. The framework injects GLSL preamble lines before
calling the node's `glsl()` function.

### SpatialConfig

```typescript
interface SpatialConfig {
  transforms: Array<'scale' | 'scaleXY' | 'rotate' | 'translate'>
  order?: 'SRT' | 'TRS' | 'RST'  // default: 'SRT'
}
```

### Generated GLSL (in order)

```glsl
// 1. Center at origin
vec2 srt_${id} = coords - 0.5;

// 2. Scale (coords /= scale, so scale=2 means "twice as large")
//    Uniform or non-uniform:
srt_${id} /= vec2(srt_scale);       // uniform scale
srt_${id} /= vec2(srt_scaleX, srt_scaleY);  // non-uniform

// 3. Rotate (aspect-corrected 2D rotation matrix)
float srt_asp_${id} = u_resolution.x / u_resolution.y;
float srt_rad_${id} = srt_rotate * 0.01745329;
float srt_c_${id} = cos(srt_rad_${id});
float srt_s_${id} = sin(srt_rad_${id});
srt_${id}.x *= srt_asp_${id};
srt_${id} = vec2(
  srt_${id}.x * srt_c_${id} - srt_${id}.y * srt_s_${id},
  srt_${id}.x * srt_s_${id} + srt_${id}.y * srt_c_${id}
);
srt_${id}.x /= srt_asp_${id};

// 4. Translate (pixel units --> UV via frozen ref size)
srt_${id} -= vec2(srt_translateX, -(srt_translateY)) / (u_dpr * u_ref_size);

// 5. Re-center
srt_${id} += 0.5;

// Replace coords input with transformed variable
inputs.coords = srt_${id};
```

### SRT params

Generated by `getSpatialParams(spatial)` in `types.ts`. All connectable,
all `updateMode: 'uniform'`.

| Transform | Params generated |
|-----------|-----------------|
| `scale` | `srt_scale` (float, default 1.0) |
| `scaleXY` | `srt_scaleX`, `srt_scaleY` (float, default 1.0) |
| `rotate` | `srt_rotate` (float, degrees, default 0) |
| `translate` | `srt_translateX`, `srt_translateY` (float, pixels, default 0) |

### Migration notes

- SRT injection is pure codegen string manipulation. Transliterate GLSL to WGSL.
- Aspect correction requires `u_resolution` -- already a standard uniform.
- The negative-Y flip in translate (`-(srt_translateY)`) accounts for
  GL's bottom-left origin. WebGPU uses top-left, so this may invert.

---

## 9. Type Coercion

**File:** `src/nodes/type-coercion.ts`

Automatic conversion between port types when connected ports have different types.
Applied at edge resolution in `generateNodeGlsl()`.

### Coercion table

| From | To | GLSL expression |
|------|----|-----------------|
| `float` | `vec2` | `vec2(v)` |
| `float` | `vec3` | `vec3(v)` |
| `float` | `vec4` | `vec4(v)` |
| `vec2` | `vec3` | `vec3(v, 0.0)` |
| `vec2` | `vec4` | `vec4(v, 0.0, 1.0)` |
| `vec3` | `vec4` | `vec4(v, 1.0)` |
| `vec4` | `vec3` | `v.rgb` |
| `vec3` | `vec2` | `v.xy` |
| `vec4` | `vec2` | `v.xy` |
| `vec2` | `float` | `v.x` |
| `vec3` | `float` | `v.x` |
| `vec4` | `float` | `v.x` |
| `color` | `vec3` | `v` (identity) |
| `vec3` | `color` | `v` (identity) |

### Migration notes

- WGSL uses the same broadcast/swizzle patterns. `vec3(v)` is `vec3<f32>(v)` in WGSL.
  Swizzles are identical syntax.
- `color` is a type alias for `vec3` at the GLSL level (identity coercion).
  In WGSL, same approach: `color` is `vec3<f32>`.

---

## 10. Node Type Inventory

41 nodes registered in `src/nodes/index.ts`.

### Category legend

| Marker | Meaning |
|--------|---------|
| **Arith** | Pure arithmetic -- single expression or simple math. Good IR candidates. |
| **Complex** | Multiple GLSL lines, function registration, conditional codegen branches. |
| **Tex** | Uses `sampler2D` (textureInput port or image sampler). |
| **Recompile** | Has params with `updateMode: 'recompile'` (triggers full recompile). |
| **Spatial** | Has `spatial` config (framework SRT injection on coords). |

### Input nodes (8)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| UV Transform | `uv_transform` | x | | | | x (scaleXY, rotate, translate) | Passthrough: `outputs.uv = inputs.coords`. All logic in SRT framework. |
| Color Constant | `color_constant` | x | | | | | Outputs literal `vec3` from color picker param. |
| Float Constant | `float_constant` | x | | | | | Outputs literal `float`. |
| Vec2 Constant | `vec2_constant` | x | | | | | Outputs literal `vec2`. |
| Time | `time` | x | | | | | `u_time * speed`. Adds `u_time` to standard uniforms. |
| Resolution | `resolution` | x | | | | | Outputs `u_resolution`. |
| Random | `random` | | x | | x (`seed`) | | Hash-based pseudo-random. Recompile on seed change. |
| Image | `image` | | x | x | x (`imageData`, `imageName`, `fitMode`) | x (scale, rotate, translate) | Texture sampling with fit/cover mode, letterboxing, aspect correction. |

### Math nodes (7)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Arithmetic | `arithmetic` | x | | | x (`operation`, `inputCount`) | | Dynamic 2-8 inputs, single-line `a + b + c`. |
| Trig | `trig` | x | | | x (`func`) | | `sin/cos/tan/abs(value * freq) * amp`. |
| Mix | `mix` | x | | | | | `mix(a, b, factor)`. |
| Remap | `remap` | x | | | | | Linear remap between ranges. |
| Clamp | `clamp` | x | | | | | `clamp(value, min, max)`. |
| Power | `power` | x | | | | | `pow(base, exponent)`. |
| Round | `round` | x | | | | | `floor/ceil/round/fract` selection. Recompile on mode. |

### Math/Distort nodes (3)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Smoothstep | `smoothstep` | x | | | | | `smoothstep(edge0, edge1, value)`. |
| Turbulence | `turbulence` | x | | | | | `abs(value * 2.0 - 1.0)`. Single expression. |
| Ridged | `ridged` | x | | | | | `1.0 - abs(value * 2.0 - 1.0)` squared. |

### Distort nodes (3)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Warp | `warp` | | x | x | x (`noiseType`, `warpDepth`, `edge`) | x (scale, translate) | Noise-based coordinate distortion. Registers noise functions. Multi-pass texture sampling with edge wrapping modes. |
| Polar Coordinates | `polar_coords` | | x | x | x (`mode`) | | Cart-to-polar and inverse. Texture sampling in both modes. |
| Tile | `tile` | | x | x | x (`mirror`) | | UV tiling with optional X/Y/XY mirroring. Texture sampling. |

### Noise nodes (2)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Noise | `noise` | | x | | x (`noiseType`) | x (scale, translate) | Registers 5-7 shared GLSL functions depending on noise type. Simplex, value, worley (3D/fast/2D), box. Seed offset. |
| FBM | `fbm` | | x | | x (`noiseType`, `fractalMode`, `octaves`) | x (scale, translate) | Registers noise functions + FBM accumulator function. Loop with max 8 iterations + early break. Content-addressed FBM key per mode+type combo. |

### Effect nodes (2)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Pixelate | `pixelate` | | x | x | | | gl_FragCoord grid snapping + FBO texture sample. Uses `u_viewport`. Sets `textureFilter: 'nearest'`. |
| Reeded Glass | `reeded_glass` | | x | x | x (`direction`, `ribType`, `waveShape`, `noiseType`) | x (scale, rotate, translate) | Most complex node. Registers reedLens + reedHash functions. 4 rib types with wave sub-shapes. Physics-based lens refraction. Frost blur loop (8 samples). Noise type sub-select. |

### Color nodes (6)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| HSV to RGB | `hsv_to_rgb` | | x | | | | Registers `hsv2rgb` shared function. Single call. |
| Brightness/Contrast | `brightness_contrast` | x | | | | | Two arithmetic operations (add + multiply). |
| Color Ramp | `color_ramp` | | x | | x (`interpolation`, `stops`) | | Data-driven codegen: N mix() calls baked from stop array. Stop positions + colors are compile-time constants. |
| Invert | `invert` | x | | | | | `1.0 - color`. |
| Grayscale | `grayscale` | x | | | | | Luminance dot product. |
| Posterize | `posterize` | x | | | | | `floor(color * levels) / levels`. |

### Pattern nodes (4)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Checkerboard | `checkerboard` | x | | | | x (scale, rotate, translate) | `mod(floor(x) + floor(y), 2.0)`. |
| Stripes | `stripes` | x | | | | x (scale, rotate, translate) | `fract` + `smoothstep` band pattern. |
| Dots | `dots` | x | | | | x (scale, rotate, translate) | `length(fract - 0.5)` circle grid. |
| Gradient | `gradient` | x | | | x (`gradientType`) | | Linear/radial/angular/diamond. Single expression per mode. |

### Vector nodes (4)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Split Vec2 | `split_vec2` | x | | | | | `.x` and `.y` extraction. |
| Split Vec3 | `split_vec3` | x | | | | | `.x`, `.y`, `.z` extraction. |
| Combine Vec2 | `combine_vec2` | x | | | | | `vec2(x, y)` construction. |
| Combine Vec3 | `combine_vec3` | x | | | | | `vec3(x, y, z)` construction. |

### Postprocess nodes (1)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Dither | `dither` | | x | | x (`shape`) | | Registers bayer8x8 + shape SDF functions. Cell-based Bayer threshold + SDF masking. |

### Output nodes (1)

| Node | Type key | Arith | Complex | Tex | Recompile | Spatial | Notes |
|------|----------|:-----:|:-------:|:---:|:---------:|:-------:|-------|
| Fragment Output | `fragment_output` | x | | | | | `fragColor = vec4(color, 1.0)`. Quality param is renderer-mode (no GLSL impact). |

### Summary counts

| Category | Count |
|----------|-------|
| Pure arithmetic (Arith) | 26 |
| Complex codegen | 15 |
| Texture sampling | 6 |
| Has recompile params | 18 |
| Has spatial transforms | 12 |
| **Total nodes** | **41** |

### Migration complexity tiers

**Tier 1 -- Trivial (26 nodes):** Pure arithmetic. Single expression or simple
math operations. GLSL-to-WGSL is mechanical: `float` -> `f32`, `vec3` -> `vec3<f32>`,
built-in functions keep same names.

**Tier 2 -- Moderate (9 nodes):** Complex codegen but no texture sampling.
Noise nodes (2), FBM, HSV to RGB, Color Ramp, Dither, Random, Warp (non-texture
path), Reeded Glass (non-texture path). Require transliterating registered GLSL
functions to WGSL. Noise functions are the bulk of the work (~300 lines total).

**Tier 3 -- Involved (6 nodes):** Texture sampling nodes. Warp, Pixelate,
Reeded Glass, Polar Coordinates, Tile, Image. Require WebGPU texture/sampler
binding, render pass management, and coordinate space adjustments. Reeded Glass
is the most complex (frost blur loop + rib type variants + noise sub-select).

---

## Appendix: Fragment Shader Template

The final assembled shader follows this structure:

```glsl
#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

// Standard uniforms (only those used by reachable nodes)
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_ref_size;
uniform float u_dpr;

// User uniforms (from uniform-mode params)
uniform float u_fbm_abc123_lacunarity;
uniform float u_noise_xyz_seed;

// Multi-pass texture samplers (if multi-pass)
uniform sampler2D u_pass0_tex;

// Image samplers (if image nodes present)
uniform sampler2D u_abc_image;

// Deduplicated helper functions
vec3 mod289(vec3 x) { ... }
float snoise3d(vec3 v) { ... }
float snoise3d_01(vec3 p) { ... }
float fbm_standard_simplex(vec3 p, float oct, float lac, float g) { ... }

void main() {
  // Per-node code in execution order (dependencies first)

  // Time (time-abc)
  float node_time_abc_time = u_time * u_time_abc_speed;

  // Noise (noise-xyz) -- with SRT preamble
  vec2 srt_noise_xyz = auto_uv_noise_xyz - 0.5;
  srt_noise_xyz /= vec2(u_noise_xyz_srt_scale);
  srt_noise_xyz += 0.5;
  vec2 n_soff_noise_xyz = fract(vec2(u_noise_xyz_seed) * vec2(12.9898, 78.233)) * 1000.0;
  vec2 n_sc_noise_xyz = srt_noise_xyz + n_soff_noise_xyz;
  float node_noise_xyz_value = snoise3d_01(vec3(n_sc_noise_xyz, node_time_abc_time));

  // Color Ramp (ramp-abc)
  vec3 node_ramp_abc_color = vec3(0.0, 0.0, 0.0);
  node_ramp_abc_color = mix(node_ramp_abc_color, vec3(0.2, 0.4, 1.0),
    smoothstep(0.0, 0.5, node_noise_xyz_value));
  node_ramp_abc_color = mix(node_ramp_abc_color, vec3(1.0, 0.8, 0.0),
    smoothstep(0.5, 1.0, node_noise_xyz_value));

  // Fragment Output
  fragColor = vec4(node_ramp_abc_color, 1.0);
}
```

### Vertex shader (constant)

```glsl
#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
```

This vertex shader is the same for all passes and all graphs. In WebGPU, it
becomes a fullscreen-triangle vertex shader (or equivalent fullscreen quad).
