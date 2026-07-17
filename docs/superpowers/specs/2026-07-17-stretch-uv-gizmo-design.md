# Stretch-Mode UV Gizmo (directional Stretch gradients + resize-tracking snap)

**Date:** 2026-07-17
**Status:** design (approved inline via decision questions; building per standing "make the call, flag it")
**Scope:** Give the Gradient node's **Stretch** draw mode the same gizmo as Pinned — draggable P0/P1 endpoints, connector, aspect handle, shape outline, Shift-angle snap, and the 9-point magnet — but in **UV (normalized) space**. Because UV coords renormalize on resize, an anchor-snapped handle tracks its canvas landmark (corner/edge/centre) natively, satisfying "locked positions follow the window on resize."

## Motivation

Today Stretch is a **fixed axis** (linear = `v_uv.x`; radial/angular/diamond = fixed centre at 0.5). It has no control points, so the new 9-point magnet (Pinned-only) has nothing to snap in Stretch, and Pinned's snapped px is frozen (doesn't track corners on resize). Storing handles in **UV** makes them inherently responsive: normalized `1.0` is always the edge, `0.5` always the centre.

## Governing principles

- **Reusable framework.** The overlay becomes **coordinate-space-aware** (`GizmoPoint.space: 'px' | 'uv'`); gradient is a consumer. Magnet + Shift-angle already run in *screen* space, so they work for both spaces unchanged — only the final screen↔param conversion branches on `space`.
- **WGSL first, both backends, parity** (`verify-ir-poc` + `validate-wgsl-multipass`), `tsc`/`lint` clean.
- Canvas-centre-invariance and live preview-follow unchanged.

## Part 1 — Framework: coordinate spaces

### `gizmo-coords.ts`
Add UV mapping (origin top-left, Y-down, matching `v_uv`):
```ts
uvToScreen(u, v, rect): { x: rect.left + u*rect.width,  y: rect.top + v*rect.height }
screenToUv(sx, sy, rect): { u: (sx-rect.left)/rect.width, v: (sy-rect.top)/rect.height }
```
Existing `pointPxToScreen`/`screenToPointPx` (px space, canvas-centre origin, Y-up) unchanged.

### `types.ts`
- `GizmoPoint`: add `space?: 'px' | 'uv'` (default `'px'`).
- Aspect handle & outline derive their geometry from the *screen* positions of their center/end points, so they inherit the space transparently — no `space` field needed on them.

### `PreviewGizmoOverlay.tsx`
- Two dispatch helpers keyed on a point's `space`:
  - `toScreen(point, xVal, yVal, rect)` → `space==='uv' ? uvToScreen : pointPxToScreen`.
  - `fromScreen(point, sx, sy, rect)` → `space==='uv' ? screenToUv : screenToPointPx`.
- Replace direct `pointPxToScreen`/`screenToPointPx` calls (render-time `pointScreenPos`, aspect-drag pivot reconstruction, point-drag write-back) with the dispatchers.
- Magnet + Shift-angle logic **unchanged** (screen space); only the write-back `fromScreen` picks up the space.
- A point's param values in UV space are `u`/`v` (0..1) rather than px, but the overlay treats them as opaque numbers — the space only decides the mapping.

## Part 2 — Gradient: UV params + field + gizmo

### Params (new, `showWhen: { drawMode: 'stretch' }`)
- `p0u, p0v` — Start / Centre. Default **`0.5, 0.5`** (canvas centre — matches Pinned's centre-origin semantics).
- `p1u, p1v` — End / Edge. Default **`1.0, 0.5`** (right-edge centre).
- `aspectUV` (float, default 1, min 0.1, max 10, step 0.01) — `showWhen: { drawMode: 'stretch', gradientType: ['radial','angular','diamond'] }`.
- All `connectable`, `updateMode: 'uniform'`.
- Keep the existing Pinned params (`p0x/p0y/p1x/p1y/aspect`) unchanged; separate sets per mode (UV and px cannot share raw values; drawMode switching is intentional).

### Field math (both backends), Stretch — same shape as Pinned but coords = `v_uv`, no `u_ref_size`
With `C = (p0u,p0v)`, `P = (p1u,p1v)`, `A = aspectUV`:
```
u = P - C; L = max(length(u), 1e-6); uh = u / L; vh = vec2(-uh.y, uh.x);
d = v_uv - C; a = dot(d, uh) / L; b = dot(d, vh) / (A * L);
linear:  t = a;
radial:  t = length(vec2(a, b));
diamond: t = abs(a) + abs(b);
angular: t = fract(atan2(b, a) / 2π);   // seam on the +u (P0→P1) line
```
Feed `t` through the existing stops chain (unchanged).

**Backward-compat note (flagged):** existing saved Stretch gradients gain default UV params on load. Centre-origin defaults reproduce the current **radial/angular/diamond** centred look exactly. **Linear** shifts from full-span left→right (`v_uv.x`) to centre-origin (`t=0` at centre, left half clamps to the first stop). Drag P0 to the left edge to restore the old full-span linear. Accepted as a graceful defaults change for a new capability.

### gizmo config (Stretch set, all `space:'uv'`, `showWhen: { drawMode:'stretch' }`)
- points: `p0uv`(→`p0u/p0v`), `p1uv`(→`p1u/p1v`), both `shape:'circle'`, `space:'uv'`.
- connector `p0uv → p1uv`.
- aspectHandle `aspectUV`, center `p0uv`, end `p1uv`, `shape:'circle'`, gated to radial|angular|diamond.
- outline: ellipse (radial|angular), diamond (diamond).
- The existing Pinned gizmo set stays; both sets coexist in one `GizmoConfig`, gated by `drawMode` via `showWhen`.

## Behavior on resize (the whole point)
Stored UV param stays constant; the overlay maps through the *current* rect each frame (rAF follow already does this), so a handle snapped to `u=1` stays glued to the right edge at any window size. The shader reads UV uniforms + `v_uv`, so the field re-fits the new canvas automatically — no recompile, uniform path only.

## Out of scope
- Cross-mode jump-prevention (switching Stretch↔Pinned may move the gradient — intentional).
- Aspect-preserving anchor-lock in *Pinned* (the heavier hybrid; not chosen).
- Non-perpendicular / free second handle.

## Open calls (made, flag to change)
1. Full gizmo parity in Stretch (endpoints + aspect + outline). ✓ (user chose full parity)
2. Centre-origin UV defaults `(0.5,0.5)→(1,0.5)`; linear default shifts (flagged above). ✓ (call)
3. Separate param sets per mode, no cross-mode continuity. ✓ (call)
