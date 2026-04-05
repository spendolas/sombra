# Phase 1a — IR Proof of Concept Report

**Date:** 2026-04-02
**Scope:** 3 nodes (Mix, Clamp, Split Vec2)
**Status:** All 3 nodes pass GLSL equivalence check ✅

---

## 1. IR Type Definitions

Created `src/compiler/ir/types.ts` with the following types:

### Expressions (discriminated union on `kind`)

| Type | Kind | Purpose |
|------|------|---------|
| `IRLiteral` | `'literal'` | Numeric/vector constants |
| `IRVariable` | `'variable'` | Variable references |
| `IRBinaryOp` | `'binary'` | Arithmetic/comparison operators |
| `IRCall` | `'call'` | Function calls (mix, clamp, etc.) |
| `IRSwizzle` | `'swizzle'` | Component extraction (.x, .xy, .rgb) |
| `IRConstruct` | `'construct'` | Type constructors (vec3(...)) |
| `IRTernary` | `'ternary'` | Conditional expressions |

### Statements

| Type | Kind | Purpose |
|------|------|---------|
| `IRDeclare` | `'declare'` | Variable declaration + initialization |
| `IRAssign` | `'assign'` | Variable assignment (for mutable vars) |

### Supporting types

- `IRType`: `'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool' | 'sampler2D'`
- `IRUniform`: uniform declaration with name, type, updateMode
- `IRNodeOutput`: bundle of statements + uniforms + standard uniforms
- `IRContext`: node ID, inputs, outputs, params (same shape as GLSLContext)

### Builder helpers

`literal()`, `variable()`, `binary()`, `call()`, `swizzle()`, `construct()`, `ternary()`, `declare()`, `assign()`

### Decisions diverging from the plan

- Added `'%'`, comparison, and logical operators to `IRBinaryOp.op` (the plan only listed `+-*/`). These are needed by future nodes.
- Used `ifTrue`/`ifFalse` instead of `then`/`else` for `IRTernary` fields to avoid the `else` keyword.
- All interfaces use `readonly` fields — IR nodes are immutable once constructed.

---

## 2. Per-Node Results

### Mix Node (`src/nodes/math/mix.ts`)

**IR structure:**
```
declare("node_mix_abc123_result", vec3,
  call("mix", [var("a_input"), var("b_input"), var("factor_input")], vec3))
```

**Reference GLSL (from `glsl()`):**
```glsl
vec3 node_mix_abc123_result = mix(node_noise_xyz_value, node_color_def_color, u_mix_abc123_factor);
```

**IR → GLSL (from `ir()` + GLSL backend):**
```glsl
vec3 node_mix_abc123_result = mix(node_noise_xyz_value, node_color_def_color, u_mix_abc123_factor);
```

**Result:** ✅ Identical

---

### Clamp Node (`src/nodes/math/clamp.ts`)

**IR structure:**
```
declare("node_clamp_def456_result", float,
  call("clamp", [var("value_input"), var("min_input"), var("max_input")], float))
```

**Reference GLSL (from `glsl()`):**
```glsl
float node_clamp_def456_result = clamp(node_noise_xyz_value, u_clamp_def456_min, u_clamp_def456_max);
```

**IR → GLSL (from `ir()` + GLSL backend):**
```glsl
float node_clamp_def456_result = clamp(node_noise_xyz_value, u_clamp_def456_min, u_clamp_def456_max);
```

**Result:** ✅ Identical

---

### Split Vec2 Node (`src/nodes/vector/split-vec2.ts`)

**IR structure:**
```
declare("node_split_ghi789_x", float, swizzle(var("vector_input"), "x", float))
declare("node_split_ghi789_y", float, swizzle(var("vector_input"), "y", float))
```

**Reference GLSL (from `glsl()`):**
```glsl
float node_split_ghi789_x = node_uv_xyz_coords.x;
float node_split_ghi789_y = node_uv_xyz_coords.y;
```

**IR → GLSL (from `ir()` + GLSL backend):**
```glsl
float node_split_ghi789_x = node_uv_xyz_coords.x;
float node_split_ghi789_y = node_uv_xyz_coords.y;
```

**Result:** ✅ Identical

---

## 3. WGSL Samples

### Mix
```wgsl
let node_mix_abc123_result: vec3f = mix(node_noise_xyz_value, node_color_def_color, u_mix_abc123_factor);
```

### Clamp
```wgsl
let node_clamp_def456_result: f32 = clamp(node_noise_xyz_value, u_clamp_def456_min, u_clamp_def456_max);
```

### Split Vec2
```wgsl
let node_split_ghi789_x: f32 = node_uv_xyz_coords.x;
let node_split_ghi789_y: f32 = node_uv_xyz_coords.y;
```

All WGSL output uses correct type names (`f32`, `vec3f`) and declaration syntax (`let x: type = expr;`). The `mix` and `clamp` builtins have identical names in WGSL, so the output is structurally the same as GLSL.

---

## 4. Issues Encountered

### No issues for these 3 trivial nodes

The IR types, GLSL backend, and WGSL backend all worked as designed for these nodes. The `glsl()` → `ir()` migration was nearly mechanical for all three.

### Noted edge case: `uniforms` field is empty for all 3 nodes

The `ir()` function returns `uniforms: []` because uniform declarations are handled by the compiler pipeline (`generateNodeGlsl` in `glsl-generator.ts`), not by the node's code generation function. The node only receives resolved variable names via `inputs` — it doesn't know whether a variable is a uniform or an upstream output. This design is correct and should be preserved.

### Type information is redundant in some IR nodes

The `type` field on `IRCall`, `IRSwizzle`, and `IRBinaryOp` is technically redundant for the 3 POC nodes (the return type can be inferred from the function name and argument types). However, explicit types are needed for the WGSL backend which requires explicit type annotations, and will be essential for more complex nodes. Keeping them explicit is the right call.

---

## 5. Recommendations Before Migrating Remaining Nodes

### For Phase 1a (remaining 23 trivial nodes)

1. **The current IR types are sufficient.** All trivial nodes use only `declare`, `call`, `variable`, `swizzle`, `construct`, and `binary` — all covered.

2. **Consider adding `IRRawGLSL` escape hatch.** Some trivial nodes have minor formatting quirks (e.g., the `round` node's `floor`/`ceil`/`round` enum generates different function calls). The IR handles this via `call()` with different function names, which works fine. No escape hatch needed for trivial nodes.

3. **The `ir` property on NodeDefinition uses inline `import()` types** to avoid adding an import to `types.ts`. This is fine for now but should become a proper import once the IR path is committed as the production path.

### For Phase 1b (moderate nodes — noise, FBM, color ramp)

4. **Add `IRFunction` type** for shared function declarations (noise functions, HSV, bayer matrix). This needs a `key` field for deduplication matching the existing `functionRegistry` pattern.

5. **Add `IRForLoop` type** for FBM's octave loop with early break.

6. **Add `IRSpatialTransform`** or equivalent to model the SRT framework injection. Currently the compiler injects SRT as raw GLSL preamble lines — the IR should model this as a structured concept so both backends can lower it correctly.

### For Phase 1c (involved nodes — texture sampling)

7. **Add `IRTextureSample` type** with separate texture/sampler references for the WGSL binding model.

---

## Verification

```
$ npx tsx scripts/verify-ir-poc.ts

  Mix Node:        ✅ GLSL MATCH
  Clamp Node:      ✅ GLSL MATCH
  Split Vec2 Node: ✅ GLSL MATCH

  SUMMARY: 3 passed, 0 failed
```

TypeScript: `npx tsc --noEmit` — zero errors
Build: `npm run build` — succeeds
