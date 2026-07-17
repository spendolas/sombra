# Gizmo Aspect Handles + Shape Outlines (radial/diamond)

**Date:** 2026-07-17
**Status:** design (Figma-referenced; building per standing "make the call, flag it" directive)
**Scope:** Extend the preview-gizmo framework with marker shapes, a perpendicular aspect handle, and drawn shape outlines; apply to the Gradient node's Radial, Angular + Diamond modes (elliptical/aspect-scaled fields). Linear unchanged.

## Goal

Adopt Figma's gradient-handle model for radial/diamond gradients: a **center** handle, an **endpoint** handle (primary radius + angle), a perpendicular **aspect** handle (secondary radius), and a drawn **shape outline** (ellipse / diamond). The endpoint sits exactly on the gradient's visible `t=1` extent, and aspect is also a slider param.

## Governing principles

- **Reusable framework, not gradient-specific.** Marker shapes, the aspect-handle kind, and outline drawing live in the gizmo framework (`types.ts`, `PreviewGizmoOverlay.tsx`). Gradient is a consumer.
- **Canvas-centre-relative** (survives anchor changes) and **live preview-follow** — keep the model from the prior fixes.
- **WGSL first, both backends, parity** (`verify-ir-poc` + `validate-wgsl-multipass`).
- **Aspect = scalar param + perpendicular-constrained handle** (not a free 2nd handle). `aspect` = secondary radius / primary radius; default 1 (circle/square).

## Part 1 — Framework additions

### GizmoPoint
- Add `shape?: 'circle' | 'diamond' | 'square'` (default `'circle'`) → the overlay renders the marker accordingly (rotated-square for diamond).
- Add a perpendicular **aspect handle** kind:
  ```ts
  interface GizmoAspectHandle {
    id: string
    shape?: 'circle' | 'diamond' | 'square'
    aspectParam: string   // scalar param this handle reads/writes
    centerPoint: string   // gizmo point id of the center
    endPoint: string      // gizmo point id of the primary endpoint
    showWhen?: Record<string, string | string[]>
  }
  ```
  Position (derived, not stored as x/y): `C + perp(normalize(E−C)) * aspect * |E−C|` where `perp((x,y)) = (−y, x)`. Drag → `aspect = dot(cursor−C, perpDir) / |E−C|` (clamped ≥ small epsilon). It is NOT bound to x/y px params.

### GizmoConfig
- Add `outline?: { shape: 'ellipse' | 'diamond', centerPoint: string, endPoint: string, aspectParam: string, showWhen?: ... }`. The overlay draws it as an SVG path: an ellipse/diamond centered at `C`, primary semi-axis = `|E−C|` along `E−C`, secondary semi-axis = `aspect * |E−C|` perpendicular, rotated to the `E−C` angle. Stroke = connector colour (indigo), thin.
- `points`/`connectors` unchanged; `aspectHandles?: GizmoAspectHandle[]` added.

### Overlay
- Render marker shapes (circle = current div; diamond = 45°-rotated square div; square = un-rotated).
- Render aspect handles at their derived positions; drag updates the scalar aspect param (robust window-listener drag, same as points).
- Render outline paths (ellipse via SVG `<ellipse>` with transform, or a `<path>`; diamond via `<polygon>`).

## Part 2 — Gradient (radial + diamond)

### Params
- Add `radialAspect` (float, default 1, min ~0.1, max ~10, step 0.01, connectable, uniform) shown when `drawMode:'pinned'` & `gradientType:'radial'`.
- Add `diamondAspect` (same) shown for `gradientType:'diamond'`. (Two params so each type keeps its own; or one shared `aspect` param gated to radial|diamond — decide in plan; leaning shared `aspect`.)

### gizmo config (radial/diamond)
- center `c` (diamond marker), endpoint (radial `e` / diamond `k`, diamond marker), aspect handle bound to the aspect param with `centerPoint:'c'`, `endPoint:'e'|'k'`, square marker; `outline` shape ellipse (radial) / diamond (diamond).
- Linear keeps a→b (circle markers, line connector, no outline). Angular keeps center + ref (unchanged).

### Field math (both backends)
Given center `C`, endpoint `P` (radial E / diamond K), `aspect` (scalar):
- `u = P − C`; `L = max(length(u), 1e-6)`; `uh = u / L`; `vh = vec2(−uh.y, uh.x)` (perpendicular).
- `d = coords − C`; `a = dot(d, uh) / L`; `b = dot(d, vh) / (aspect * L)`.
- **Radial**: `t = length(vec2(a, b))` → `t=1` on the ellipse.
- **Diamond**: `t = abs(a) + abs(b)` → `t=1` on the diamond.
- Feed `t` through the stops mix-chain (unchanged). This guarantees the endpoint handle (at `a=1,b=0`) is exactly the visible `t=1` on the primary axis, and the outline traces `t=1`.

## Line-aligns-to-extent

Because the field is defined so `t=1` at the endpoint along the primary axis, the center→endpoint line ends exactly where the gradient reaches its last stop (fixes the current diamond mismatch). The drawn outline traces the full `t=1` locus.

## Out of scope
- Linear aspect. Free-form (non-perpendicular) second handles. Rotating the aspect independently of the endpoint angle (aspect is always perpendicular to center→endpoint).

## Open calls (made, flag to change)
1. Aspect = scalar + perpendicular handle (not free 2nd handle). ✓
2. Radial + Diamond only. ✓
3. Markers: diamond (center/endpoint), square (aspect). ✓
4. One shared `aspect` param gated to radial|diamond (vs per-type) — plan decides; default shared.
