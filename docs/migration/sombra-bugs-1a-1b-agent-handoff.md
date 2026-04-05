# Sombra WebGPU Migration — Bug Fixes + Phase 1a Completion + Phase 1b — Agent Handoff

## Priority 1: Fix Phase 0 Bugs

Three issues were found during visual testing of the Phase 0 abstraction seam. All three must be fixed and verified before proceeding.

### Bug 1 — Preview thumbnails not rendering on initial load

**Symptom:** Preview thumbnails on node cards are blank when the app first loads. They appear immediately on first interaction (e.g., dragging a slider). After that first interaction they work correctly, including downstream dirty propagation.

**Likely cause:** The preview scheduler isn't triggering on the initial compile completion. The scheduler probably starts before the first compile finishes, sees nothing dirty, goes idle, and never wakes up until a user-initiated change marks nodes dirty.

**Fix direction:** Ensure the scheduler processes the initial render plan. Either the scheduler needs to detect the first compile result and queue all visible nodes for preview, or the initial compile path needs to explicitly mark nodes as dirty.

**Verify:** Launch the app fresh. All nodes connected to the output chain should show preview thumbnails without any user interaction.

### Bug 2 — Viewer renders differently since Phase 0

**Symptom:** The viewer entry point (`viewer.ts`) renders shaders that look visually different from the editor. This was accurate before Phase 0 — the refactor introduced the divergence.

**Likely cause:** The factory function refactor in `viewer.ts` changed something in the init sequence — canvas setup, context configuration, render plan application, `u_ref_size` calculation, DPR handling, or viewport setup. Compare the old `viewer.ts` (pre-Phase 0, check git diff) against the new version line by line to find what changed beyond the factory swap.

**Fix direction:** The viewer must produce identical output to the editor for the same graph. The only expected difference is canvas size (viewer is fullscreen, editor is panel-constrained) — spatial scaling via `u_ref_size` and `u_resolution` should handle that correctly.

**Verify:** Open the same graph in both the editor and viewer. The visual output should match (accounting for aspect ratio / canvas size differences, but not color, pattern, or scale differences).

### Bug 3 — WebGL console errors

**Symptom:** Browser console shows accumulated WebGL errors:
- 16x `GL_INVALID_OPERATION: invalid mailbox name`
- 32x `GL_INVALID_OPERATION: texture is not a shared image`

**Likely cause:** Either pre-existing (from the two-context architecture / OffscreenCanvas) or introduced by Phase 0 changes to context initialization or texture lifecycle.

**Fix direction:**
1. First, determine if these are pre-existing. Check out the commit before Phase 0, run the app, and check the console. If they exist there too, note them as pre-existing and move on.
2. If they're new, the refactor changed something in how contexts are created, how textures are shared between contexts, or the order of operations. Check the factory function init sequence, particularly the preview renderer's OffscreenCanvas creation.

**Verify:** Console should be clean of these errors (if they're new), or documented as pre-existing (if they existed before Phase 0).

### Verification gate

After all three bugs are fixed:
- [ ] `tsc --noEmit` — zero errors
- [ ] `npm run build` — builds successfully
- [ ] Fresh app load: preview thumbnails visible immediately on all connected nodes
- [ ] Viewer output matches editor output for the same graph
- [ ] Console clean (or only pre-existing warnings documented)
- [ ] Rerun the full visual test checklist:
  - Single-pass uniform fast path (slider drag → smooth update)
  - Recompile path (noise type dropdown → pattern changes)
  - Multi-pass rendering (Noise → Color Ramp → Warp texture input)
  - Preview dirty propagation (slider drag → upstream + downstream thumbnails update)
  - Animation (Time node wired in → continuous motion)
  - Window resize (no black bars, no aspect ratio issues)

**Do not proceed to Phase 1a completion until all checks pass.**

---

## Priority 2: Complete Phase 1a — Remaining 23 Trivial Nodes

After bugs are fixed, migrate the remaining 23 trivial nodes. The 3 POC nodes (Mix, Clamp, Split Vec2) are already done.

### Remaining nodes (23)

**Math (6):** Arithmetic, Trig, Remap, Power, Round, Smoothstep

**Math/Distort (2):** Turbulence, Ridged

**Color (5):** Brightness/Contrast, Invert, Grayscale, Posterize, Fragment Output

**Pattern (4):** Checkerboard, Stripes, Dots, Gradient

**Vector (2):** Split Vec3, Combine Vec2, Combine Vec3

**Input (3):** Time, UV Coordinates, Resolution

### For each node:
1. Add `ir()` function alongside existing `glsl()` — do not remove or modify `glsl()`
2. The `ir()` function should produce an `IRNodeOutput` using the builder helpers from `src/compiler/ir/types.ts`
3. Verify: run the IR → GLSL backend on the node's output and diff against the old `glsl()` output. They must be identical.
4. Also run the IR → WGSL backend and check that the output is syntactically valid.

### Nodes with special considerations:
- **Arithmetic** — has dynamic 2-8 inputs and `operation` as a recompile param. The IR needs to handle variable-length binary op chains.
- **Trig** — has `func` as a recompile param that selects sin/cos/tan/abs. The function name is baked at compile time.
- **Round** — has mode selection (floor/ceil/round/fract) as a recompile param. Same pattern as Trig.
- **Gradient** — has `gradientType` as a recompile param that switches between entirely different expressions (linear/radial/angular/diamond).
- **Fragment Output** — simple `fragColor = vec4(color, 1.0)` but needs the special output assignment in the IR.

### Verification after all 26 nodes:
- [ ] Run the verification script across all 26 nodes (including the original 3 POC)
- [ ] All produce byte-identical GLSL via both paths
- [ ] All produce valid WGSL via the WGSL backend
- [ ] `tsc --noEmit` and `npm run build` clean

---

## Priority 3: Execute Phase 1b — IR for Moderate Nodes (9 nodes)

### Scope

Noise (2), FBM, HSV to RGB, Color Ramp, Dither, Random, and the non-texture codegen paths of Warp and Reeded Glass.

### New IR types to add

Before migrating nodes, extend `src/compiler/ir/types.ts` with the four types flagged in the Phase 1a report:

**1. IRFunction** — shared helper functions (noise, HSV, bayer matrix):

```typescript
interface IRFunction {
  key: string;           // content-addressed dedup key
  name: string;          // function name in generated code
  params: { name: string; type: IRType }[];
  returnType: IRType;
  body: IRStatement[];   // function body as IR statements
}
```

Add a `functions: IRFunction[]` field to `IRNodeOutput`.

**2. IRForLoop** — FBM octave loop:

```typescript
interface IRForLoop extends IRNode {
  kind: 'for';
  iterVar: string;
  from: IRExpr;
  to: IRExpr;
  body: IRStatement[];
  earlyBreak?: IRExpr;
}
```

Add to the `IRStatement` union.

**3. IRSpatialTransform** — SRT framework for 12 spatial nodes:

```typescript
interface IRSpatialTransform {
  coordsVar: string;
  outputVar: string;
  scaleUniform?: string;
  rotateUniform?: string;
  translateUniform?: string;
}
```

Add an optional `spatialTransform?: IRSpatialTransform` field to `IRNodeOutput`. Both backends generate the transform preamble from this.

**4. IRTextureSample** — texture sampling (needed for Phase 1c, but define the type now):

```typescript
interface IRTextureSample extends IRNode {
  kind: 'textureSample';
  sampler: string;
  coords: IRExpr;
  type: IRType;
}
```

Add to the `IRExpr` union. Don't use it yet in any node's `ir()` — it's just the type definition for Phase 1c.

### Update both backends

After adding the new IR types, update `glsl-backend.ts` and `wgsl-backend.ts` to handle them:

- `IRFunction` → GLSL function declaration / WGSL function declaration (watch for type syntax differences)
- `IRForLoop` → GLSL `for` loop / WGSL `for` loop (syntax is similar but WGSL uses `var` for loop variable)
- `IRSpatialTransform` → emit the SRT coordinate transform preamble in both languages
- `IRTextureSample` → GLSL `texture(sampler, coords)` / WGSL `textureSample(texture, sampler, coords)` — implement now even though no node uses it yet

### Migrate the 9 nodes

For each node, follow the same pattern: add `ir()` alongside `glsl()`, verify byte-identical GLSL output.

**Key challenges:**

- **Noise nodes** — register 5-7 shared GLSL functions depending on noise type. These ~300 lines of noise functions must be expressed as `IRFunction` bodies. The GLSL backend emits them as-is; the WGSL backend transliterates. Watch for:
  - `mod(x, y)` → WGSL uses `%` for floats, but behavior with negative values may differ. Test with negative inputs.
  - No `out` parameters in WGSL — restructure any functions that use them to return values instead.

- **FBM** — uses a `for` loop with baked octave count and early break. Uses `IRForLoop`. The content-addressed FBM function key (per mode+type combo) must be preserved for dedup.

- **Color Ramp** — data-driven codegen: N `mix()` calls baked from stop array. Stop positions and colors are compile-time constants (recompile params). The IR must generate a variable-length chain of mix statements from the stop data.

- **Dither** — registers bayer8x8 matrix + shape SDF functions. Similar pattern to noise function registration.

- **HSV to RGB** — registers `hsv2rgb` shared function. Single function registration + single call.

- **Random** — hash-based pseudo-random. Recompile on seed change.

- **Warp / Reeded Glass (non-texture path only)** — migrate only the computation path. Skip texture sampling operations — those are Phase 1c. If the node's `ir()` can't cleanly separate the two paths, note this in the report and we'll address it in Phase 1c.

### Verification after all 9 nodes:
- [ ] All 9 produce byte-identical GLSL via both paths
- [ ] All produce valid WGSL via the WGSL backend
- [ ] Function deduplication works — shared noise functions emitted once per shader, not per node
- [ ] SRT preamble generates correctly for spatial nodes
- [ ] FBM loop with early break generates correctly in both GLSL and WGSL
- [ ] `tsc --noEmit` and `npm run build` clean

---

## Deliverables

### From bug fixes:
- Modified files as needed to fix bugs 1, 2, 3
- Brief note on each: what was wrong, what was changed

### From Phase 1a completion:
- 23 additional node files modified (added `ir()`)
- Verification script results for all 26 trivial nodes

### From Phase 1b:
- Updated `src/compiler/ir/types.ts` with 4 new IR types
- Updated `src/compiler/ir/glsl-backend.ts` and `wgsl-backend.ts` with new type handlers
- 9 node files modified (added `ir()`)
- Report: `docs/migration/phase1b-report.md` covering:
  - Per-node migration results
  - GLSL diff results
  - WGSL samples for noise functions and FBM loop
  - Any issues with GLSL→WGSL transliteration (especially `mod`, `out` params)
  - Any issues separating texture/non-texture paths for Warp and Reeded Glass
  - Recommendations for Phase 1c

---

## Constraints

- Fix all 3 bugs before starting Phase 1a completion
- Verify Phase 1a completion before starting Phase 1b
- Do not remove any existing `glsl()` functions — IR is additive
- Do not wire the IR path into the production compilation pipeline — it remains experimental
- Do not start Phase 1c (texture sampling nodes) — stop after 1b and report
- Verify with `tsc --noEmit` and `npm run build` after each priority completes
