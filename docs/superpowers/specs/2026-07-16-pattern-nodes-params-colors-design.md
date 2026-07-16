# Pattern Nodes — Proper Params + Built-in Colors

**Date:** 2026-07-16
**Status:** design (awaiting review)
**Scope:** Stripes, Dots, Checkerboard, Gradient. Noise/FBM explicitly excluded.

## Goal

Give the basic **Pattern** nodes proper, orthogonal, real-value parameters for every
procedural feature they express — instead of leaning on the spatial **Scale**
transform as a catch-all. Add built-in colors so each pattern can produce a
finished image on its own, while staying composable.

## Governing principles

1. **Scale is not a feature control.** The spatial SRT `Scale` transforms the whole
   coordinate space, dragging every coord-driven feature with it. Each procedural
   feature gets its own intrinsic param on the node.
2. **Real values, in pixels.** Sizes/spacings are CSS pixels, resolved through
   `u_dpr * u_ref_size` exactly like the Offset (translate) params — so they are
   **resize-stable** (frozen-reference sizing).
3. **Colors by arity.** Binary patterns (two states) → two color pickers `A`/`B`.
   Continuous patterns (a range) → multi-stop ramp. "Two colors" is the degenerate
   2-stop case of a ramp.
4. **Keep composability.** Every node keeps a float **`Value`** output alongside the
   new **`Color`** output. Colors are built-in for convenience; the raw field still
   drives Color Ramp / Mix / anything downstream.
5. **WebGPU first, both backends.** Author the WGSL (`ir/wgsl-backend`) path first,
   then mirror to both GLSL paths (`ir/glsl-backend`, legacy `glsl-generator`), keep
   parity (`verify-ir-poc` + `validate-wgsl-multipass`).

## Per-node spec

Legend: params are `connectable: true` unless noted. `updateMode: 'uniform'` unless
noted (enums and stop-count changes are `'recompile'`).

### Stripes  — output: `Color` (primary) + `value` (float)
Field is binary (stripe / gap). Current math: `fract(coords.x)` with hardcoded 50% duty.

| param | type | range | default | wiring |
|---|---|---|---|---|
| Width | float px | 1–512 | 40 | stripe thickness |
| Gap | float px | 0–512 | 40 | space between stripes |
| Softness | float | 0–1 | 0 (exists) | edge AA |
| Color A | color | | opaque white `[1,1,1,1]` | stripe |
| Color B | color | | opaque black `[0,0,0,1]` | gap |

- Period `P = (Width + Gap)` px → coord units `P / (u_dpr * u_ref_size)`.
  `duty = Width / P`. `t = fract(coords.x / P_units)`; band via smoothstep(duty, softness).
- `value` = band mask (0..1). `Color = mix(B, A, band)`.
- Spatial unchanged (scale/rotate/translate; rotation is already aspect-free).

### Dots — output: `Color` (primary) + `value` (float)
Field is binary (dot / background). Current math: `fract(sc)-0.5; length; smoothstep(radius)`.

| param | type | range | default | wiring |
|---|---|---|---|---|
| Gap X | float px | 1–512 | 60 | grid spacing, x |
| Gap Y | float px | 1–512 | 60 | grid spacing, y |
| Radius | float | 0.01–0.5 | (exists) | dot size (fraction of cell) |
| Aspect | float | 0.25–4 | 1 | dot **shape** ellipticity only — must NOT affect spacing |
| Softness | float | 0–0.5 | (exists) | edge AA |
| Color A | color | | opaque white | dot |
| Color B | color | | opaque black | background |

- Cell spacing from Gap X/Y px → coord units per axis. `cell = fract(coords / gap_units) - 0.5`.
- Dot shape uses Aspect on the distance metric only: `d = length(cell * vec2(aspect, 1.0))`,
  keeping the grid spacing (gap) independent of shape.
- `value = 1 - smoothstep(radius - softness, radius + softness, d)`. `Color = mix(B, A, value)`.

### Checkerboard — output: `Color` (primary) + `value` (float)
Field is binary. Current math: `mod(floor(coords).x + floor(coords).y, 2)`, zero params.

| param | type | range | default | wiring |
|---|---|---|---|---|
| Tile Mode | enum `cellSize`\|`density` | | `cellSize` | recompile; selects which sizing control is active |
| Cell Size | float px | 1–512 | 40 | *(shown when mode = cellSize)* edge length of one square |
| Density | float | 1–128 | 8 | *(shown when mode = density)* squares across the reference span |
| Softness | float | 0–0.5 | 0 | edge AA |
| Color A | color | | opaque white | |
| Color B | color | | opaque black | |

- `cellSize` mode: cell coord unit = `CellSize / (u_dpr * u_ref_size)`.
- `density` mode: cell coord unit = `1 / Density` (across the reference span; resize-stable).
- `value = mod(floor(coords/cell).x + floor(coords/cell).y, 2)`, AA'd by Softness
  (smoothstep across the cell boundary). `Color = mix(B, A, value)`.
- `showWhen` hides the inactive sizing param. Spatial unchanged.

### Gradient — output: `Color` (primary) + `value` (float)
Field is continuous. Currently outputs float only; **no spatial**.

| param | type | notes |
|---|---|---|
| Type | enum | linear / radial / angular / diamond (exists) |
| Stops | stops | multi-color ramp; reuse the Color Ramp editor + `stops` param + interpolation |
| *spatial* | scale/rotate/translate | **NEW** — add `spatial` config so gradients can be angled/scaled/offset like every other pattern |

- The float shape field (existing per-Type math) becomes `value`. `Color` = the field
  sampled through Stops (same lerp logic as `ColorRampEditor` / `color_ramp` node).
- Stops changes are `recompile` (stop count affects codegen), matching `color_ramp`.

## Output-type change + backward compatibility

- All four nodes' **primary output becomes `color`** (was `float` for checkerboard/
  gradient; stripes/dots gain color as primary). A secondary `value` (float) output is
  added so existing downstream float consumers keep working; `color → float` coercion
  also remains valid, so **existing edges do not break**.
- Default colors are black/white, so a `.x`/value read reproduces the old 0/1 field.
- **Known look shift:** patterns currently sit at "one repeat per reference unit"
  (density set via Scale). With real-pixel defaults (~40px), **existing saved graphs
  render at a different density on reload.** No clean auto-migration (old look was
  resolution-relative). Accepted as part of this overhaul.

## System-wide touchpoints (per CLAUDE.md checklist)

- Node files in `src/nodes/pattern/` (both `glsl()` + `ir()`), keep GLSL↔IR parity.
- Verify: `verify-ir-poc`, `validate-wgsl-multipass`, `tsc`, `lint`.
- Update `BROWSER-AUTOMATION.md` node param tables; `.figma/wiki/templates/node-templates.md`;
  node templates. Node count unchanged.
- New port shape: nodes now emit `color` + `value`; update any docs listing their outputs.
- Multi-color params reuse existing `RgbaColorPicker` / `ColorRampEditor`; no new DS component expected.

## Out of scope

- Noise, FBM (stay float; pair with existing Color Ramp).
- New gradient math modes; gradient `Power`/contrast (dropped).
- Per-node dedicated Frequency multipliers (replaced by real-value Width/Gap/Cell Size).
