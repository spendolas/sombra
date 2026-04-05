# Sombra WebGPU Migration — WGSL Fixes + Phase 1c — Agent Handoff

## Context

Phases 0, 1a, and 1b are complete. 34 of 41 nodes have `ir()` functions. The GLSL backend produces correct output. The WGSL backend has 4 known issues in the noise/math function output that must be fixed before proceeding. There's also a cosmetic parenthesization diff in the GLSL backend to clean up.

Read the full migration plan (`sombra-webgpu-migration-plan-v2.md`) and the Phase 1b report (`docs/migration/phase1b-report.md`) for context.

---

## Priority 1: Fix GLSL Parenthesization

**Issue:** The GLSL backend wraps `binary()` expressions in defensive parens — `(a + b)` instead of `a + b`. This produces 12 cosmetic diffs against the old `glsl()` output across the 26 trivial nodes.

**Fix:** In `src/compiler/ir/glsl-backend.ts`, skip outer parentheses when a binary op is the direct value of a `declare` or `assign` statement. The binary op emitter should still parenthesize when the expression is nested inside another expression.

**Verify:** Rerun the verification script across all 34 nodes with `ir()` functions. The 12 cosmetic diffs should drop to 0. All nodes should produce byte-identical GLSL via both paths.

---

## Priority 2: Fix WGSL Issues (4 issues)

All four issues are in the mechanical GLSL→WGSL translation applied to `IRRawCode` function bodies. Fix them either by enhancing the mechanical translator or by providing explicit WGSL overrides via the `wgsl?` field on the affected `IRRawCode` nodes. Choose whichever approach is cleaner per-issue — it's fine to mix both strategies.

### Issue 1: `const` syntax

**Problem:** Translator produces `const vec2f C = vec2f(...)` — GLSL style with type before name.  
**WGSL requires:** `const C: vec2f = vec2f(...)`  
**Affected:** `snoise3d` and potentially other functions with `const` declarations.  
**Fix:** The translator (or override) must rewrite `const TYPE NAME = ...` → `const NAME: TYPE = ...` for WGSL output.

### Issue 2: Missing `var`/`let` keywords

**Problem:** Translator produces `vec3f i = floor(p)` — bare type declarations without `var` or `let`.  
**WGSL requires:** `var i: vec3f = floor(p)` (mutable) or `let i: vec3f = floor(p)` (immutable).  
**Affected:** All function bodies that declare local variables.  
**Fix:** The translator must detect bare `TYPE NAME = expr` patterns and rewrite to `var NAME: TYPE = expr` (use `var` by default since mutability analysis is complex; `let` is an optimization that can come later).

### Issue 3: `for` loop variable declarations

**Problem:** Translator produces `for (i32 z = -1; ...)` — GLSL-style loop init.  
**WGSL requires:** `for (var z: i32 = -1; ...)`  
**Affected:** Worley noise loops, potentially FBM loops.  
**Fix:** The translator must detect loop init declarations and rewrite to `for (var NAME: TYPE = expr; ...)`. Note: if FBM loops go through `IRForLoop` rather than `IRRawCode`, they may already emit correctly from the WGSL backend — check and confirm.

### Issue 4: Function overloading

**Problem:** GLSL allows `mod289(vec3)` and `mod289(vec4)` as overloaded functions. WGSL does not support function overloading.  
**Affected:** `mod289` (vec3 and vec4 variants), and any other noise utility functions with type-overloaded signatures.  
**Fix:** In the WGSL backend (or WGSL overrides), emit disambiguated function names: `mod289_v3` / `mod289_v4`. The dedup keys already distinguish these variants, so the mapping is: dedup key → WGSL function name. All call sites within WGSL function bodies must also reference the disambiguated names.

**Important:** This renaming must be consistent — if `snoise3d` calls `mod289(someVec3)`, the WGSL version must call `mod289_v3(someVec3)`. If you're using explicit WGSL overrides for function bodies, the overridden body must use the renamed function names throughout.

### Verification

After fixing all 4 issues:

- [ ] Run ALL WGSL output (all 34 nodes, all 17 noise functions) through a WGSL validator. Options:
  - Use Tint (Chrome's shader compiler) if available
  - Use Naga (wgpu's shader compiler) via `naga-cli`: `naga --validate input.wgsl`
  - At minimum, wrap the output in a minimal valid WGSL module (with struct definitions for uniforms, vertex output, etc.) and validate syntax
- [ ] No WGSL validation errors for any node
- [ ] GLSL output unchanged (the WGSL fixes must not affect GLSL backend output)
- [ ] `tsc --noEmit` and `npm run build` clean

If Tint/Naga aren't available in the environment, produce the full WGSL output for all noise functions and the FBM loop in the report so it can be validated externally.

---

## Priority 3: Execute Phase 1c — IR for Involved Nodes (6 nodes)

### Scope

The 6 texture-sampling nodes. After this, all 41 nodes will have `ir()` functions — completing the entire IR migration layer.

**Nodes:**
1. **Warp** (`src/nodes/distort/warp.ts`) — noise-based coordinate distortion with texture sampling and edge wrapping modes
2. **Pixelate** (`src/nodes/effect/pixelate.ts`) — gl_FragCoord grid snapping + FBO texture sample, nearest-neighbor filtering
3. **Reeded Glass** (`src/nodes/effect/reeded-glass.ts`) — most complex node: rib types, wave sub-shapes, lens refraction, frost blur loop (8 samples), noise sub-select
4. **Polar Coordinates** (`src/nodes/distort/polar-coords.ts`) — cartesian-to-polar and inverse, texture sampling in both modes
5. **Tile** (`src/nodes/distort/tile.ts`) — UV tiling with optional mirror modes, texture sampling
6. **Image** (`src/nodes/input/image.ts`) — texture sampling with fit modes (contain/cover/fill/tile), aspect correction, SRT framework

### IR texture sampling

These nodes use the `IRTextureSample` type defined in Phase 1b:

```typescript
interface IRTextureSample extends IRNode {
  kind: 'textureSample';
  sampler: string;       // e.g., "u_pass0_tex" or "u_abc_image"
  coords: IRExpr;        // UV coordinates expression
  type: IRType;          // vec4
}
```

The critical GLSL→WGSL divergence here: GLSL combines texture and sampler into `sampler2D`, while WGSL separates them.

**GLSL output:**
```glsl
uniform sampler2D u_pass0_tex;
// ...
vec4 color = texture(u_pass0_tex, coords);
```

**WGSL output:**
```wgsl
@group(0) @binding(N) var u_pass0_tex: texture_2d<f32>;
@group(0) @binding(N+1) var u_pass0_sampler: sampler;
// ...
var color: vec4f = textureSample(u_pass0_tex, u_pass0_sampler, coords);
```

The WGSL backend must:
1. Emit separate texture and sampler bindings for each `sampler2D` uniform
2. Assign binding indices (track a counter or use a deterministic scheme)
3. Emit `textureSample(texture, sampler, coords)` calls instead of `texture(sampler, coords)`

### Multi-pass awareness

These nodes trigger pass partitioning in the compiler. The IR itself doesn't need to know about passes — `partitionPasses()` in `glsl-generator.ts` operates on graph topology, not IR. But:

- The IR output for these nodes must include `IRTextureSample` operations so both backends can lower them correctly
- The uniform list must include the texture sampler uniforms
- Node re-emission (same node's code appearing in multiple passes) must work with the IR path — the compiler calls `ir()` again for re-emitted nodes, and function dedup ensures shared functions aren't duplicated

### Per-node notes

**Warp** — already has non-texture `ir()` from Phase 1b. Extend it to handle the texture sampling path. The texture path activates when the node has a wired `textureInput` port. The `ir()` function needs to check whether texture mode is active and emit `IRTextureSample` accordingly. Edge wrapping modes (`clamp`, `repeat`, `mirror`) map to sampler configuration — this is renderer-level (bind group sampler descriptor), not shader-level in WebGPU. Include the wrapping mode in metadata on the `IRTextureSample` or as a separate annotation.

**Reeded Glass** — already has non-texture `ir()` from Phase 1b. The frost blur loop (8 directional texture samples) is the main addition. Each sample is an `IRTextureSample` at a different UV offset. The loop structure already exists via `IRForLoop` or unrolled statements — extend it with texture sampling.

**Pixelate** — grid snapping uses `gl_FragCoord` (GLSL) / `@builtin(position)` (WGSL). The texture sample reads the snapped coordinate from the FBO. Nearest-neighbor filtering is a sampler setting (`textureFilter: 'nearest'`) — include this as metadata.

**Polar Coordinates** — two modes (cart-to-polar and polar-to-cart). Both involve texture sampling with transformed coordinates. Relatively straightforward once `IRTextureSample` works.

**Tile** — UV tiling with mirror modes (none/X/Y/XY). Mirror mode is a recompile param that changes the UV math. Texture sampling is a single `IRTextureSample` at the tiled coordinates.

**Image** — texture sampling with fit mode (contain/cover/fill/tile) as a recompile param. Each mode produces different UV transform math. Also has SRT framework (spatial transforms) — the `IRSpatialTransform` from Phase 1b handles this. The sampler name follows the pattern `u_${nodeId}_image`.

### Verification

After all 6 nodes:

- [ ] All 6 produce byte-identical GLSL via both paths (old `glsl()` vs new `ir()` → GLSL backend)
- [ ] All 6 produce valid WGSL via the WGSL backend
- [ ] Texture sampling emits correctly in both languages
- [ ] WGSL backend emits separate texture + sampler bindings
- [ ] Multi-pass graphs with texture boundaries still partition correctly (no changes expected to partitioning logic, but verify)
- [ ] Node re-emission works with IR path for cross-pass non-texture dependencies
- [ ] Run verification across ALL 41 nodes to confirm no regressions
- [ ] `tsc --noEmit` and `npm run build` clean

---

## Deliverables

### From Priority 1 (parenthesization fix):
- Modified `src/compiler/ir/glsl-backend.ts`
- Verification script results showing 0 diffs across all 34 nodes

### From Priority 2 (WGSL fixes):
- Modified files (translator and/or WGSL overrides on affected `IRRawCode` nodes)
- WGSL validation results (or full WGSL output for external validation)

### From Priority 3 (Phase 1c):
- 6 node files modified (added or extended `ir()`)
- Updated GLSL and WGSL backends if needed for texture sampling
- Report: `docs/migration/phase1c-report.md` covering:
  - Per-node migration results and GLSL diff results
  - WGSL texture sampling output samples
  - How edge wrapping modes and texture filter settings are represented
  - How WGSL separate texture/sampler bindings are assigned
  - Any issues with Reeded Glass frost blur loop
  - Any issues with Image node fit modes
  - Confirmation that all 41 nodes now have `ir()` functions
  - Recommendations for Phase 2a (WebGPU renderer)

---

## Constraints

- Fix parenthesization before WGSL fixes (so GLSL verification baseline is clean)
- Fix WGSL issues before starting Phase 1c (so texture sampling WGSL builds on valid foundations)
- Do not remove any existing `glsl()` functions
- Do not wire the IR path into the production compilation pipeline
- Do not start Phase 2a (WebGPU renderer) — stop after 1c and report
- Verify with `tsc --noEmit` and `npm run build` after each priority completes
