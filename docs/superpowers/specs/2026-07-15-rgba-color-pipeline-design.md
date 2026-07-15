# RGBA Color Pipeline — Design

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan
**Branch:** continues on `feat/transparent-output` — this extends that work and depends on its vec4 `fragment_output` + transparent-clear foundation

## Goal

Make alpha an intrinsic, first-class part of every color in the node graph.
Today color travels as `vec3` and alpha is dropped at every node boundary
(alpha exists only at `image` → and `fragment_output`). After this change, a
color with alpha &lt; 1 — including a value picked in a color swatch — stays
transparent all the way through generators, transforms, and effects to the
screen. No new toggles or mode switches: transparency is a property of color,
not a feature you turn on.

## Decisions (from brainstorming)

1. **Color becomes RGBA (vec4) everywhere** — the canonical color carrier is
   4-component; color-carrying ports move from `vec3` to the `color` type,
   redefined as RGBA.
2. **Swatches upgrade to an alpha-capable picker** — the `color` param control
   becomes a small custom RGBA picker (color area + hue + alpha slider). This
   is the only UI change; it is the same swatch, made alpha-aware, not a new
   switch/dropdown.
3. **Transforms edit alpha as a normal channel**, except color-space ops.
4. **`mix` blends alpha** along with rgb.

## Approach

`color` (currently an alias for `vec3`, rendered with a color picker) is
redefined as a **4-component RGBA** type. Every port that carries a *color*
moves to `color`; ports that carry non-color data (UV coords `vec2`, scalar
`float`, HSV triples, pattern masks) are unchanged. Color-producing nodes emit
RGBA; color-consuming/transforming nodes handle the 4th channel per the rules
below; `fragment_output` already reads `.a` and premultiplies.

Backward compatibility rides on coercion: an old `vec3` color value coerces to
RGBA with `a = 1.0`, so existing graphs render pixel-identical (opaque).

## Per-node alpha rules

Nodes fall into categories. **The first plan phase audits each node's actual
output/input port types** and assigns it a category — the lists below are the
expected classification and must be confirmed against the code (some
distort/pattern nodes output UV `vec2` or a scalar mask, not color, and are
then unaffected).

| Category | Alpha behavior | Nodes (to confirm in audit) |
|---|---|---|
| **Generator** (produces a color) | Output RGBA; alpha from swatch/stop/source, default `1.0` | `color_constant` (RGBA swatch), `color_ramp`/`gradient` (stops gain alpha), `hsv_to_rgb` (out RGBA, a=1), `image` (already RGBA) |
| **Channel transform** (generic value math on a color) | Operate on all of RGBA — alpha is another channel | `invert`, `posterize`, `brightness_contrast`, and generic math (`remap`, `clamp`, `power`, `round`, `smoothstep`, `arithmetic`) when a color flows through |
| **Color-space op** | Preserve alpha unchanged (no meaningful op on it) | `grayscale`, `hsv_to_rgb` input side / hue-sat |
| **Blend** | Interpolate/blend rgb **and** alpha | `mix` |
| **Spatial** (resample/move pixels) | Alpha rides with the sampled color automatically | `warp`, `pixelate`, `tile`, `polar_coords`*, `reeded_glass`, `pixel_grid`/dither — *only where they carry color; those that output UV `vec2` are non-color |
| **Non-color** | Unaffected | `float_constant`, `vec2_constant`, `time`, `resolution`, `random`, `uv_coords`, `noise`/`fbm`/`ridged`/`turbulence` (scalar), pattern masks that output `float`, `trig`, vector split/combine |

Notes:
- **Generic math nodes** (`arithmetic`, `remap`, `clamp`, `power`, `round`,
  `smoothstep`) already operate on whatever vector type flows through them; once
  a `color`/RGBA value can reach them, they process all 4 components with no
  per-node change beyond type acceptance. This is the "channel transform"
  behavior for free.
- **Pattern generators** (`checkerboard`, `dots`, `gradient`, `stripes`): audit
  whether each outputs a color (→ RGBA) or a scalar mask (`float`, unaffected).

## Type system + coercion

- **`color` PortType** redefined as RGBA (4 floats). `paramGlslType('color')`
  → `vec4`. `port-colors.ts` entry for `color` unchanged (same wire color).
- **Coercion** — update both `COERCION_RULES` (GLSL) and `coerceTypeForIR`
  (WGSL) so they stay in sync (the two-table split is a known risk; this change
  touches both — verify parity):
  - `vec3 → color`: `vec4(v, 1.0)` / `vec4f(v, 1.0)` (opaque)
  - `color → vec3`: `v.rgb`
  - `color ↔ vec4`: identity
  - `float → color`: `vec4(vec3(v), 1.0)`
  - `color → float`: `v.x`
- **`isValidConnection`** is coercion-driven; no direct change, but confirm
  color↔vec3↔vec4 connections still validate after the redefinition.
- **Default value formatting** (`formatDefaultValue`) must emit a 4-component
  literal for `color` defaults.

## RGBA swatch picker

- Replace the native `<input type="color">` used by the `color` param with a
  small custom picker component: saturation/value area + hue slider + **alpha
  slider**, value `[r, g, b, a]`. Reused by both `NodeParameters` and
  `PropertiesPanel` wherever a `color` param renders.
- Must be self-contained (no external color-picker dependency unless already
  present); keep it Tailwind + DS-token styled. If any new visual tokens are
  needed, route through the DS pipeline (`sombra.ds.json` → `npm run tokens`),
  else queue in `.claude/ds-queue.md`.
- The picker is `nodrag nowheel` when on a node (React Flow interception —
  learned from the background control).

## Backward compatibility

- **Saved graphs:** vec3 color connections coerce to `a = 1.0`; the
  `color_constant` default `[1,0,1]` → `[1,0,1,1]` via param-default merge (both
  `.sombra` import and compact-URL decode already merge definition defaults).
  Existing graphs render opaque, pixel-identical.
- **`color` params stored as 3-tuples** in old saves: the param loader/merge
  pads to 4 with `a = 1.0`.

## Backends + verification

- WebGPU (WGSL) and WebGL2 (GLSL) paths migrated **together per node**; both
  must stay green.
- `scripts/verify-ir-poc.ts`: extend/add fixtures for every migrated node so
  GLSL↔IR parity covers the RGBA output and alpha handling.
- `scripts/validate-wgsl-multipass.ts`: must stay green (0 failed) across the
  migration.
- `npm run lint`, `tsc -b` clean.
- **Live check (both backends):** a `color_constant` swatch at alpha 0.5 wired
  through a multi-node chain (e.g. → invert → mix → output) shows the expected
  transparency composited over the checker backdrop; an all-opaque legacy graph
  is pixel-unchanged.

## Suggested plan phases (each shippable)

1. **Foundation** — redefine `color` as RGBA, coercion (both tables) +
   default formatting, verify existing graphs still compile opaque. No visible
   behavior change yet (everything coerces to a=1).
2. **RGBA picker** — the swatch component; `color_constant` gains real alpha.
   First visible transparency from a swatch.
3. **Generators** — `color_ramp`/`gradient` stops, `hsv_to_rgb`, pattern
   generators that output color.
4. **Transforms/effects** — channel transforms (edit alpha), color-space ops
   (preserve), `mix` (blend), spatial (carry along). Generic math nodes verified
   to pass RGBA through.
5. **Verification sweep** — parity fixtures, WGSL, cross-backend live checks,
   backward-compat confirmation.

## Out of scope

- Alpha-specific compositing nodes (Porter-Duff over/in/atop as a node) — the
  earlier deferred "composite node family" remains separate.
- Channel split/combine for RGBA (`split_vec4`/`combine_vec4`) — additive, only
  if a phase surfaces a concrete need.
