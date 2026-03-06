# Param Classification Rules

Every `NodeParameter` has a required `updateMode` field that classifies how parameter changes are handled.

## `updateMode: 'recompile'`

The param value is read at GLSL codegen time and changes the shader's structure. Any change requires full shader recompilation.

Use for:
- **Enum/mode selectors** — `noiseType`, `fractalMode`, `operation`, `func`, `interpolation`, `shape`
- **Structural counts** — `inputCount` (changes dynamic port count), `octaves` (baked loop bound)
- **Branch-shaping params** — booleans or values that control which GLSL code path is generated
- **Hidden state that affects GLSL** — `stops` (color ramp mix chain), `decimals` (rounding precision)

## `updateMode: 'uniform'`

The param value is a numeric/color literal that does not change shader structure. Currently still baked as a GLSL literal (recompile on change), but classified for Phase 2 uniform promotion.

Use for:
- **Numeric multipliers** — `scale`, `strength`, `frequency`, `amplitude`, `gain`, `lacunarity`
- **Offset/position values** — `offsetX`, `offsetY`, `rotate`, `scaleX`, `scaleY`
- **Threshold/blend values** — `factor`, `min`, `max`, `brightness`, `contrast`, `threshold`
- **Constant outputs** — `value` (Number), `x`/`y` (Vec2), `color` (Color), `speed` (Time)
- **Seeds** — numeric seed values (hash input, not structural)

## Edge Cases

| Param | Node | Classification | Reason |
|-------|------|---------------|--------|
| `octaves` | FBM | `recompile` | Currently baked as loop bound literal. Phase 2 candidate: rewrite with MAX_OCTAVES compile-time bound + uniform-driven early break. |
| `stops` | Color Ramp | `recompile` | Hidden param encoding gradient stop array. Each stop change alters the GLSL mix chain structure. |
| `decimals` | Random | `recompile` | Baked into GLSL rounding precision expression (`pow(10.0, -decimals)`). |
| `inputCount` | Arithmetic | `recompile` | Hidden param controlling dynamic port count (2-8 inputs). |
| `seed` | Random | `uniform` | Hidden, but only used as a numeric hash input — no structural effect. |

## How semanticKey Uses This

The `semanticKey` in `use-live-compiler.ts` determines when to recompile. Currently it includes all params. Phase 2 will narrow it to only `recompile`-mode params + node types + edges, so `uniform`-mode slider changes skip recompilation entirely.

## Phase 2 Promotion Path

Params marked `uniform` will become actual WebGL uniforms in Phase 2:
1. Codegen emits `uniform float u_<nodeId>_<paramId>;` instead of baking the literal
2. `semanticKey` filters to `recompile`-mode params only — uniform slider changes no longer trigger recompile
3. `renderer.updateUniforms()` uploads current values on every frame (or on change)
4. Result: slider drags update the visual output instantly with zero shader compilation cost
