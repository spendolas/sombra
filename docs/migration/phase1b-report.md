# Phase 1b — IR for Moderate Nodes Report

**Date:** 2026-04-02
**Scope:** 8 moderate nodes + noise function helpers + 4 new IR types
**Status:** All 8 nodes have `ir()` functions, tsc + build clean ✅

---

## 1. New IR Types Added

### IRRawCode (escape hatch)
```typescript
interface IRRawCode {
  kind: 'raw'
  glsl: string      // GLSL source — emitted as-is by GLSL backend
  wgsl?: string     // optional WGSL override; mechanical translation if absent
}
```
**Decision:** The ~225 lines of noise functions would require hundreds of IR nodes if decomposed line-by-line. `IRRawCode` embeds the tested GLSL directly. The GLSL backend emits it as-is; the WGSL backend does mechanical type-name replacement (`float→f32`, `vec2→vec2f`, etc.) or uses an explicit WGSL override when mechanical translation isn't sufficient.

### IRFunction (shared helper functions)
```typescript
interface IRFunction {
  key: string                                           // content-addressed dedup key
  name: string                                          // function name
  params: ReadonlyArray<{ name: string; type: IRType }> // parameters
  returnType: IRType                                    // return type
  body: IRStmt[]                                        // function body (typically IRRawCode)
}
```
Added `functions?: IRFunction[]` to `IRNodeOutput`.

### IRForLoop
```typescript
interface IRForLoop {
  kind: 'for'
  iterVar: string
  from: IRExpr
  to: IRExpr
  body: IRStmt[]
  earlyBreak?: IRExpr   // condition for `if (cond) break;`
}
```
Added to `IRStmt` union.

### IRSpatialTransform
```typescript
interface IRSpatialTransform {
  coordsVar: string
  outputVar: string
  scaleUniform?: string
  scaleXUniform?: string
  scaleYUniform?: string
  rotateUniform?: string
  translateXUniform?: string
  translateYUniform?: string
}
```
Added `spatialTransform?: IRSpatialTransform` to `IRNodeOutput`.

### IRTextureSample (type only — Phase 1c)
```typescript
interface IRTextureSample {
  kind: 'textureSample'
  sampler: string
  coords: IRExpr
  type: IRType
}
```
Added to `IRExpr` union. No node uses it yet.

---

## 2. Backend Updates

### GLSL Backend
- `IRRawCode` → emits `glsl` string directly (with indentation)
- `IRForLoop` → `for (int i = from; i < to; i++) { if (float(i) >= earlyBreak) break; ...body... }`
- `IRFunction` → `returnType name(params) { body }`
- `IRSpatialTransform` → center → scale → rotate (aspect-corrected) → translate → recenter preamble
- `IRTextureSample` → `texture(sampler, coords)`
- Added `lowerFunctionsToGLSL(functions)` for function list with dedup by key

### WGSL Backend
- `IRRawCode` → uses explicit `wgsl` if provided, else mechanical translation (`float→f32`, `vec→vecNf`, etc.)
- `IRForLoop` → `for (var i: i32 = from; i < to; i++) { if (f32(i) >= earlyBreak) { break; } ...body... }`
- `IRFunction` → `fn name(params) -> returnType { body }`
- `IRSpatialTransform` → same preamble with WGSL types (`vec2f`, `var`, `let`)
- `IRTextureSample` → `textureSample(sampler_tex, sampler_samp, coords)` (separate bindings)
- Added `mechanicalGlslToWgsl()` for raw code type substitution
- Added `lowerFunctionsToWGSL(functions)` with dedup

---

## 3. Per-Node Migration Results

### Noise (`src/nodes/noise/noise.ts`)
- **Functions registered:** 2-7 IRFunction objects depending on noiseType (simplex needs 6, value needs 2, etc.)
- **Shared helper:** `getIRNoiseFunctions(noiseType)` in `noise-functions.ts` — returns the right IRFunction array for any noise type
- **Main computation:** Seed offset (2 raw lines) + noise function call (declare + call)
- **Box noise special case:** `floor(p) / boxFreq` preamble handled

### FBM (`src/nodes/noise/fbm.ts`)
- **Functions registered:** Noise dependency functions + FBM function itself
- **FBM function:** Content-addressed key `fbm_${fractalMode}_${noiseType}`, body uses `raw()` with the for-loop + early break
- **Fractal modes:** standard, turbulence (`abs(noise*2-1)`), ridged (`1-abs(noise*2-1)` squared)
- **Main computation:** Seed offset + FBM call with octaves/lacunarity/gain args

### HSV to RGB (`src/nodes/color/hsv-to-rgb.ts`)
- **Functions registered:** 1 IRFunction (`hsv2rgb`)
- **Function body:** `raw()` with the 4-line clamp+abs+mix HSV conversion
- **Main computation:** Single `declare + call('hsv2rgb', [h, s, v])`

### Color Ramp (`src/nodes/color/color-ramp.ts`)
- **Data-driven codegen:** Reads stop array from params, generates N-1 mix() calls
- **Pattern:** Initial `declare` for first stop color, then `assign` + `call('mix', ...)` for each subsequent stop
- **Interpolation:** `smoothstep` (smooth mode), `step` (constant mode), `clamp + divide` (linear mode)
- **No shared functions** — pure inline arithmetic

### Random (`src/nodes/input/random.ts`)
- **No shared functions** — inline hash computation
- **Computation:** 3 declare statements (step, raw value, rounded value)
- **Compile-time constants:** decimals and nodeHash baked from params

### Dither/Pixel Grid (`src/nodes/postprocess/pixel-grid.ts`)
- **Functions registered:** `bayer8x8` (always) + conditional shape SDF (`sdf_circle`, `sdf_diamond`, `sdf_triangle`) based on `shape` param
- **Complex computation:** Cell index, bayer threshold, shape mask, final color masking
- **Uses `auto_fragcoord`** via `gl_FragCoord.xy`

### Warp (`src/nodes/distort/warp.ts`)
- **Non-texture path only** — coordinate warping computation migrated
- **Texture sampling path:** Deferred to Phase 1c (commented in code)
- **Color output:** Uses UV gradient fallback (`vec3(warped, 0.5)`) when no texture

### Reeded Glass (`src/nodes/transform/reeded-glass.ts`)
- **Functions registered:** `reedLens` (cylindrical refraction) + `reedHash` (frost jitter hash)
- **Rib types:** straight, wave (6 sub-types via raw), circular, noise — all handled
- **Texture sampling path:** Deferred to Phase 1c (displacement sampling, frost blur loop)
- **Color output:** Source passthrough when no texture

---

## 4. WGSL Considerations

### Mechanical Translation
The `mechanicalGlslToWgsl()` function handles:
- `float` → `f32`, `int` → `i32`
- `vec2/3/4` → `vec2f/vec3f/vec4f`
- `mat2/3/4` → `mat2x2f/mat3x3f/mat4x4f`

### Known WGSL Issues (to address in Phase 1c or 2)
1. **`mod()` behavior:** GLSL `mod(x, y)` and WGSL `x % y` differ for negative values. Noise functions use mod with positive values only (verified in noise-functions.ts), so this is safe for Phase 1b. Phase 1c should add a `glsl_mod` polyfill for WGSL if negative inputs become possible.
2. **`const` declarations:** GLSL `const vec2 C = vec2(1.0/6.0, 1.0/3.0);` in simplex noise needs WGSL equivalent `const C: vec2f = vec2f(...)`. The mechanical translator handles `vec2→vec2f` but doesn't add `: vec2f` type annotation to `const`. This will need an explicit WGSL override for simplex noise in Phase 2.
3. **No `out` parameters:** None of the migrated functions use `out` params (verified). Not a concern for Phase 1b.
4. **Warp/Reeded Glass texture paths:** These nodes reference texture samplers and do `texture()` calls in their GLSL. The IR `ir()` functions skip these paths entirely and include comments marking them as Phase 1c.

---

## 5. Recommendations for Phase 1c

1. **IRTextureSample is ready** — the type and both backend lowerers are implemented. Nodes just need to use it.
2. **Warp + Reeded Glass need texture path completion** — the `ir()` functions have comments marking where texture sampling should go.
3. **Pixelate node** is fully migrated (no texture sampling in its computation — it reads from `gl_FragCoord.xy` directly).
4. **Image node** (`src/nodes/input/image.ts`) is the main Phase 1c target — it uses `texture(sampler, coords)` with fit-mode UV transforms.
5. **Consider explicit WGSL overrides** for the simplex noise `const` declarations before validating WGSL output with Tint/Naga.

---

## Verification

```
tsc --noEmit:  ✅ zero errors
npm run build: ✅ builds successfully (2.81s)
Node count:    34 nodes with ir() (26 trivial + 8 moderate)
```

All 8 moderate nodes have `ir()` functions alongside their existing `glsl()` functions. The `glsl()` functions are completely untouched — the IR path is additive and experimental.
