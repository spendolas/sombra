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

The param value is emitted as a GLSL uniform and uploaded at runtime. Changes require only a uniform upload — no recompile.

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

The `semanticKey` in `use-live-compiler.ts` includes only `recompile`-mode params + node types + edges. A separate `uniformKey` tracks `uniform`-mode param values. When only `uniformKey` changes, the hook calls `onUniformUpdate()` to upload values to the GPU — no shader recompilation.

## Uniform Pipeline (Active)

The uniform pipeline is live. For `uniform`-mode params:
1. Codegen emits `uniform <type> u_<nodeId>_<paramId>;` instead of baking the literal
2. `CompilationResult.userUniforms` carries specs with initial values for post-compile upload
3. `semanticKey` filters to `recompile`-mode params only — uniform slider changes don't trigger recompile
4. `uniformKey` detects uniform-mode value changes → `renderer.updateUniforms()` uploads values
5. Result: slider drags update the visual output instantly with zero shader compilation cost

Two param consumption patterns:
- **Connectable params** — resolved centrally in `glsl-generator.ts`. When unwired + uniform-mode, emits a uniform name into `ctx.inputs`
- **Non-connectable uniform params** — a separate codegen loop injects uniform names into `ctx.inputs`. The 4 affected node files (float-constant, vec2-constant, color-constant, random) read from `inputs` instead of `params`
