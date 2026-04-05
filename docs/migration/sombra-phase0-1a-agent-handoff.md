# Sombra WebGPU Migration — Phase 0 + Phase 1a Draft — Agent Handoff

## Context

Sombra is a node-based WebGL shader editor being migrated to support WebGPU alongside WebGL. A full migration plan exists (attached: `sombra-webgpu-migration-plan-v2.md`). A Phase 0 audit was already completed (attached: `renderer-surface-audit.md`, `codegen-pipeline-audit.md`, `architecture-snapshot.md`).

Read all four documents before starting. The migration plan v2 was written using the audit findings — it accounts for the two-context architecture, multi-pass FBO pipeline, async readback implications, 41 node types, viewer.ts, and all other findings.

---

## Task 1: Execute Phase 0 — Abstraction Seam

This is a mechanical refactoring. No new functionality. WebGL rendering must work identically before and after.

### Step 0.1 — Define the renderer interface

Create the `ShaderRenderer` and `PreviewRenderer` interfaces as specified in the plan's Phase 0 section. Place them in a new file:

```
src/renderer/types.ts
```

Key requirements from the plan:
- `ShaderRenderer` covers the main renderer (DOM canvas, multi-pass, animation loop)
- `PreviewRenderer` covers the preview renderer (offscreen, readback)
- `renderPreview` returns `Promise<ImageBitmap>` — async contract even for WebGL (wrap sync readPixels in resolved promise)
- `updateRenderPlan` takes the existing `RenderPlan` type from the compiler output
- `onDeviceLost` callback for device/context loss recovery
- No React dependency — `viewer.ts` must be able to use these interfaces directly

Use the plan's interface definitions as a starting point, but adapt to the actual types you find in the codebase (e.g., `RenderPlan`, `UniformValue`, etc. may already be defined). Don't duplicate types — import and reuse existing ones.

### Step 0.2 — Wrap existing WebGL renderers

Refactor the existing renderers to implement the new interfaces:

- `src/webgl/renderer.ts` → `WebGL2ShaderRenderer implements ShaderRenderer`
- `src/webgl/preview-renderer.ts` → `WebGL2PreviewRenderer implements PreviewRenderer`

This is a wrap, not a rewrite. The internal implementation stays the same. You are adding an interface on top, not changing how WebGL calls work.

The one structural change: `renderPreview` and `renderMultiPassPreview` must now return `Promise<ImageBitmap>` instead of `ImageBitmap`. For the WebGL implementation, wrap the existing sync return in `Promise.resolve(result)`.

### Step 0.3 — Create factory functions

Create a renderer factory that currently only returns WebGL backends but is structured for future WebGPU addition:

```
src/renderer/create-renderer.ts
```

```typescript
export async function createShaderRenderer(canvas: HTMLCanvasElement): Promise<ShaderRenderer> {
  // WebGPU path will be added in Phase 2a
  const renderer = new WebGL2ShaderRenderer();
  await renderer.init(canvas);
  return renderer;
}

export async function createPreviewRenderer(): Promise<PreviewRenderer> {
  // WebGPU path will be added in Phase 2b
  const renderer = new WebGL2PreviewRenderer();
  await renderer.init();
  return renderer;
}
```

### Step 0.4 — Update all consumers

Every file that directly imports or instantiates `WebGLRenderer` or `PreviewRenderer` must go through the factory or interface instead:

- `App.tsx` — use factory functions, store renderers typed as `ShaderRenderer` / `PreviewRenderer`
- `viewer.ts` — use factory function (must work without React)
- `use-live-compiler.ts` — call renderer through interface methods
- `preview-scheduler.ts` — switch `renderPreview` calls to `await` the returned promise

⚠️ **The preview scheduler change is the most delicate part.** The current batching logic assumes sync readback. When you change `renderPreview` to return a Promise, the scheduler must `await` it. This changes the timing model. For now (WebGL backend), the await resolves immediately since it's `Promise.resolve()`, so behavior is unchanged. But verify that the scheduler still batches correctly and doesn't introduce unnecessary microtask delays.

### Step 0.5 — Verify

Run these checks and report results:

- [ ] `tsc --noEmit` — zero errors
- [ ] `vite build` — builds successfully
- [ ] **Grep check:** no direct `gl.*` calls outside `src/webgl/` directory (excluding type definitions)
- [ ] **Grep check:** no direct `new WebGLRenderer()` or `new PreviewRenderer()` outside factory functions and `src/webgl/`
- [ ] Run the app — shader renders correctly (test with a multi-node graph including at least one multi-pass connection)
- [ ] Preview thumbnails render correctly for all visible nodes
- [ ] Viewer (`viewer.ts` entry point) still works standalone
- [ ] Context loss recovery still works (if testable — otherwise note as untested)

**Do not proceed to Task 2 if any verification step fails.** Fix the issue first.

---

## Task 2: Draft Phase 1a — IR Proof of Concept (3 nodes only)

**Do not migrate all 26 nodes.** Migrate exactly 3 as a proof of concept so the IR design can be reviewed before committing to the full set.

### Step 2.1 — Define IR types

Create the IR type definitions:

```
src/compiler/ir/types.ts
```

Use the plan's Phase 1a IR types as a starting point. Adapt based on what you find the codegen actually needs. The types must cover:

- Expressions: literals, variables, binary ops, function calls, swizzles, constructors, ternary
- Statements: declare, assign
- Uniforms: name, type, updateMode
- Standard uniforms: set of built-in uniform names needed
- Node output: the bundle of statements + uniforms a single node contributes

Include builder/helper functions for ergonomic IR construction:

```typescript
// Helpers like:
function literal(type: IRType, value: number | number[]): IRLiteral;
function variable(name: string, type?: IRType): IRVariable;
function call(name: string, args: IRExpr[], returnType?: IRType): IRCall;
function declare(name: string, type: IRType, value: IRExpr): IRDeclare;
function binary(op: string, left: IRExpr, right: IRExpr, type?: IRType): IRBinaryOp;
```

### Step 2.2 — GLSL backend

Create the IR-to-GLSL lowering pass:

```
src/compiler/ir/glsl-backend.ts
```

This takes an `IRNodeOutput` and produces a GLSL code string. For the 3 proof-of-concept nodes, this should produce output **identical** to what the current direct `glsl()` function produces (modulo whitespace).

### Step 2.3 — WGSL backend

Create the IR-to-WGSL lowering pass:

```
src/compiler/ir/wgsl-backend.ts
```

Same input, WGSL output. Key differences to handle:
- `float` → `f32`, `vec2` → `vec2f`, `vec3` → `vec3f`, `vec4` → `vec4f`
- `int` → `i32`
- Variable declarations: `float x = expr;` → `var x: f32 = expr;`
- Type constructors: `vec3(1.0, 0.0, 0.0)` → `vec3f(1.0, 0.0, 0.0)`

### Step 2.4 — Migrate 3 nodes

Add an `ir(ctx: IRContext) => IRNodeOutput` function to exactly these 3 nodes:

1. **Mix** (`src/nodes/math/mix.ts`) — simple `mix(a, b, factor)` call. Tests function call IR.
2. **Clamp** (`src/nodes/math/clamp.ts`) — simple `clamp(value, min, max)` call. Tests multi-arg function call.
3. **Split Vec2** (`src/nodes/vector/split-vec2.ts`) — `.x` and `.y` extraction. Tests swizzle IR and multiple outputs.

For each node:
- Keep the existing `glsl()` function untouched
- Add the new `ir()` function alongside it
- Both should coexist — the old path is the fallback

### Step 2.5 — Verify the IR path

For each of the 3 migrated nodes:

1. Build a test graph that uses the node with wired inputs and uniform-mode params
2. Run the graph through both paths:
   - Old: `glsl(ctx)` → GLSL string
   - New: `ir(ctx)` → IR → GLSL backend → GLSL string
3. **Diff the GLSL output.** It should be identical (or equivalent modulo whitespace/formatting). Report any differences.
4. Run the IR through the WGSL backend and verify the output is syntactically valid WGSL.

### Step 2.6 — Report

Produce a brief report covering:

1. **IR type definitions** — list the types you defined, note any decisions you made that diverge from the plan
2. **Per-node results** — for each of the 3 nodes, show the old GLSL output vs new IR→GLSL output and note any differences
3. **WGSL samples** — show the WGSL output for each node
4. **Issues encountered** — anything that didn't fit the IR model cleanly, any edge cases, any types that feel wrong
5. **Recommendations** — changes to the IR types before migrating the remaining 23 trivial nodes

---

## Constraints

- **Phase 0 must be fully complete and verified before starting Task 2.** Don't interleave.
- **Do not migrate more than 3 nodes.** The IR design needs review before scaling.
- **Do not remove the old `glsl()` functions.** They remain as the production path. The IR path is experimental until reviewed.
- **Do not touch the Web Worker, compiler pipeline, or preview scheduler internals** beyond what's needed for the interface refactor in Phase 0.
- **Do not create a WebGPU renderer.** That's Phase 2, not now.
- **If the interface doesn't fit cleanly** around the existing renderer code, document why and propose alternatives rather than forcing it. The interface in the plan is a starting point, not gospel.
- **Verify with `tsc --noEmit` and `vite build`** after each major step.

---

## Output

### From Task 1 (Phase 0):

New/modified files:
```
src/renderer/types.ts              # NEW: ShaderRenderer + PreviewRenderer interfaces
src/renderer/create-renderer.ts    # NEW: factory functions
src/webgl/renderer.ts              # MODIFIED: implements ShaderRenderer
src/webgl/preview-renderer.ts      # MODIFIED: implements PreviewRenderer
src/App.tsx                        # MODIFIED: uses factory
src/viewer.ts                      # MODIFIED: uses factory
src/compiler/use-live-compiler.ts  # MODIFIED: uses interface types
src/webgl/preview-scheduler.ts     # MODIFIED: awaits preview renders
```

### From Task 2 (Phase 1a draft):

New files:
```
src/compiler/ir/types.ts           # IR type definitions + builder helpers
src/compiler/ir/glsl-backend.ts    # IR → GLSL lowering
src/compiler/ir/wgsl-backend.ts    # IR → WGSL lowering
```

Modified files (3 nodes only):
```
src/nodes/math/mix.ts              # MODIFIED: added ir() alongside glsl()
src/nodes/math/clamp.ts            # MODIFIED: added ir() alongside glsl()
src/nodes/vector/split-vec2.ts     # MODIFIED: added ir() alongside glsl()
```

Report:
```
docs/migration/phase1a-poc-report.md
```
