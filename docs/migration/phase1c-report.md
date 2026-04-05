# Phase 1c — IR for Texture-Sampling Nodes + WGSL Fixes Report

**Date:** 2026-04-02
**Scope:** GLSL paren fix + 4 WGSL fixes + 6 texture-sampling nodes + 3 constant nodes
**Status:** All 41/41 nodes have `ir()` functions. IR migration layer complete. ✅

---

## 1. GLSL Parenthesization Fix

**Problem:** GLSL backend wrapped all `binary()` expressions in defensive parens — `(a + b)` — causing 12 cosmetic diffs against hand-written `glsl()` output.

**Fix:** Implemented precedence-aware parenthesization in `lowerExprToGLSL()`:
- Binary ops only parenthesize when nested inside a higher-precedence parent
- Same-precedence right operands parenthesize for non-commutative ops (subtraction, division)
- Function call arguments, declare values, and assign values never add outer parens

**Result:** 26/26 trivial nodes now produce **byte-identical** GLSL via both paths.

Also fixed 2 IR construction issues in node files:
- `brightness-contrast.ts`: used `literal('vec3', [0.5, 0.5, 0.5])` → changed to `literal('float', 0.5)` (GLSL auto-broadcasts)
- `dots.ts`: used `construct('vec2', [literal('float', 0.5)])` → changed to `literal('float', 0.5)`

---

## 2. WGSL Fixes (4 Issues)

### Issue 1: `const` syntax ✅
Enhanced `mechanicalGlslToWgsl()` to rewrite `const TYPE NAME =` → `const NAME: TYPE =` before type name replacement. Applies line-by-line via regex.

### Issue 2: Missing `var`/`let` keywords ✅
Enhanced translator to detect bare `TYPE NAME = expr` declarations at line start and rewrite to `var NAME: TYPE = expr`. Uses `var` by default (mutability analysis deferred).

### Issue 3: For-loop variable declarations ✅
Enhanced translator to detect `for (TYPE NAME = expr; ...)` and rewrite to `for (var NAME: TYPE = expr; ...)`.

### Issue 4: Function overloading ✅
- Added `WGSL_OVERLOAD_NAMES` map: `mod289` → `mod289_v3` (vec3 variant) / `mod289_v4` (vec4 variant)
- `lowerFunctionToWGSL()` resolves disambiguated names via dedup key
- Provided explicit WGSL override for `snoise3d` body (calls `mod289_v3(i)` instead of `mod289(i)`)
- Provided explicit WGSL override for `permute` body (calls `mod289_v4(...)`)

### WGSL output verification

Simplex noise (6 functions) — all issues resolved:
- `fn mod289_v3(x: vec3f) -> vec3f` / `fn mod289_v4(x: vec4f) -> vec4f` (disambiguated)
- `fn permute` calls `mod289_v4(...)` (correct overload)
- `fn snoise3d` uses `const C: vec2f = ...`, `var i: vec3f = ...`, `i = mod289_v3(i)` (all 4 issues fixed)
- Worley uses `for (var z: i32 = -1; ...)` (Issue 3 fixed)

---

## 3. Phase 1c — Texture-Sampling Nodes

### IRContext Extension

Added two optional fields to `IRContext` (`src/compiler/ir/types.ts`):
- `textureSamplers?: Record<string, string>` — portId → sampler2D uniform name (multi-pass FBO inputs)
- `imageSamplers?: Set<string>` — image sampler uniform names

These mirror the existing `GLSLContext` fields, allowing `ir()` functions to detect and handle texture mode the same way `glsl()` does.

### Per-Node Results

#### Warp (`src/nodes/distort/warp.ts`)
- Extended existing non-texture `ir()` with texture sampling path
- Texture mode: computes `auto_uv` from `gl_FragCoord`, applies SRT scale/translate, edge wrapping (clamp/repeat/mirror), then `textureSample()`
- Non-texture mode: UV gradient fallback (preserved from Phase 1b)
- Standard uniforms: `u_resolution`, `u_dpr`, `u_ref_size` (for auto_uv computation)

#### Reeded Glass (`src/nodes/transform/reeded-glass.ts`)
- Extended existing non-texture `ir()` with texture sampling + frost blur
- Texture mode: displacement-based sampling at distorted UV + 8-sample frost blur loop (via `raw()`)
- Frost conditional: `if (frost > 0.001)` branches between blurred and clean path
- Non-texture mode: source passthrough (preserved from Phase 1b)

#### Pixelate (`src/nodes/distort/pixelate.ts`)
- New `ir()` with `gl_FragCoord.xy` grid snapping
- Texture mode: `textureSample()` at quantized cell-center UV (normalized by `u_viewport`)
- Non-texture mode: checkerboard pattern fallback
- Standard uniforms: `u_viewport`

#### Polar Coordinates (`src/nodes/distort/polar-coords.ts`)
- New `ir()` with two modes (recompile param `direction`):
  - Forward (cartesian→polar): `length()` for r, `atan()` for theta
  - Inverse (polar→cartesian): `cos()`/`sin()` reconstruction
- Texture mode: `textureSample()` at transformed coordinates
- Non-texture mode: UV passthrough

#### Tile (`src/nodes/distort/tile.ts`)
- New `ir()` with mirror modes (recompile param `mirror`): none, x, y, xy
- No mirror: `fract(coords * count)` tiling
- Mirror modes: triangle-wave reflection via `raw()` per axis
- Texture mode: `textureSample()` at tiled coordinates
- Non-texture mode: UV gradient fallback

#### Image (`src/nodes/input/image.ts`)
- New `ir()` with fit modes (recompile param `fitMode`): contain, cover, fill, tile
- Contain/cover: aspect ratio correction with letterbox/crop via `raw()` conditional
- Registers sampler name in `ctx.imageSamplers`
- No-image fallback: mid-gray placeholder
- SRT spatial transforms supported via `IRSpatialTransform`

### Constant Nodes (3 additions)
Also added `ir()` to the 3 remaining constant nodes to reach 41/41:
- `float-constant.ts`: `declare(value, 'float', variable(input))`
- `color-constant.ts`: `declare(color, 'vec3', variable(input))`
- `vec2-constant.ts`: `declare(value, 'vec2', construct('vec2', [x, y]))`

---

## 4. Texture Sampling WGSL Output

### GLSL
```glsl
uniform sampler2D u_pass0_tex;
vec4 color = texture(u_pass0_tex, coords);
```

### WGSL (from backend)
```wgsl
// textureSample emits:
textureSample(u_pass0_tex_tex, u_pass0_tex_samp, coords)
```

The WGSL backend appends `_tex` and `_samp` suffixes to the sampler name, creating separate texture and sampler binding references. The actual `@group/@binding` declarations would be emitted by the full shader assembler (not yet wired up — that's Phase 2a scope).

### Edge wrapping and texture filter settings

These are **sampler configuration**, not shader code:
- **Edge wrapping** (clamp/repeat/mirror): In WebGPU, set via `GPUSamplerDescriptor.addressModeU/V`
- **Texture filtering** (linear/nearest): Set via `GPUSamplerDescriptor.minFilter/magFilter`

The IR path annotates these as metadata but they don't affect the WGSL shader code — they affect bind group setup in the renderer.

---

## 5. Coverage Summary

| Phase | Nodes | Cumulative |
|-------|-------|-----------|
| 1a POC | 3 | 3 |
| 1a completion | +23 | 26 |
| 1b moderate | +8 | 34 |
| 1c texture + constants | +7 | **41** |

**All 41 node types in the registry now have `ir()` functions.**

---

## 6. Recommendations for Phase 2a (WebGPU Renderer)

1. **WGSL shader assembler needed** — The IR backends produce per-node GLSL/WGSL code, but a full shader needs the header (version, precision, uniform declarations, function declarations, main() wrapper). The GLSL assembler exists (`assembleFragmentShader` in `glsl-generator.ts`). A WGSL equivalent is needed that:
   - Emits `@group/@binding` declarations for uniforms and textures
   - Handles separate texture/sampler bindings
   - Emits `@fragment fn main(...) -> @location(0) vec4f { ... }`

2. **Uniform buffer layout** — WGSL packs uniforms into struct + buffer. The assembler needs to compute byte offsets and alignment for all active uniforms.

3. **Compile pipeline integration** — Currently `ir()` is additive/experimental. To use it for WebGPU rendering:
   - Worker calls `ir()` → WGSL backend instead of `glsl()`
   - Feature flag to select old GLSL path vs new IR path
   - Diff testing against existing GLSL output during transition

4. **Per-pixel visual regression tests** — Before declaring WebGPU output visually equivalent, render representative graphs on both backends and compare per-pixel. The GLSL path is the reference.

5. **`IRRawCode` WGSL overrides** — Most noise/utility functions work via mechanical translation. Only `snoise3d` and `permute` needed explicit WGSL overrides. As more complex functions are added, the override pattern scales: provide explicit WGSL only when mechanical translation is insufficient.

---

## Verification

```
tsc --noEmit:   ✅ zero errors
npm run build:  ✅ builds successfully
Node count:     41/41 with ir()
GLSL matches:   26/26 trivial nodes byte-identical (verification script)
```
