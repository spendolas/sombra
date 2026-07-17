# Gizmo Aspect Handles + Shape Outlines — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Framework: marker shapes + a perpendicular aspect handle + drawn shape outlines. Gradient: Radial + Diamond become elliptical/aspect-scaled with a Center/Endpoint/Aspect gizmo and an ellipse/diamond outline whose extent matches the shader.

**Spec:** `docs/superpowers/specs/2026-07-17-gizmo-aspect-shape-outline-design.md` (read for full detail).

## Global Constraints
- Reusable framework (no gradient logic in `types.ts`/`PreviewGizmoOverlay.tsx`).
- Keep the existing model: points relative to preview CANVAS CENTRE (anchor-invariant, module const `GIZMO_ANCHOR = [0.5,0.5]`), live rAF preview-follow, robust window-listener drag (no pointer capture).
- WGSL first, mirror both GLSL paths, parity via `verify-ir-poc` + `validate-wgsl-multipass`; `tsc`/`lint` clean each task. Controller owns live browser verify.
- Aspect = scalar param + perpendicular-constrained handle. Perp of `(x,y)` = `(-y, x)`.

---

### Task 1: Framework — marker shapes, aspect handle, outline

**Files:** `src/nodes/types.ts`, `src/components/PreviewGizmoOverlay.tsx`

**Types (`types.ts`):**
- `GizmoPoint`: add `shape?: 'circle' | 'diamond' | 'square'`.
- Add:
  ```ts
  export interface GizmoAspectHandle {
    id: string
    shape?: 'circle' | 'diamond' | 'square'
    aspectParam: string
    centerPoint: string  // GizmoPoint id
    endPoint: string     // GizmoPoint id
    showWhen?: Record<string, string | string[]>
  }
  export interface GizmoOutline {
    shape: 'ellipse' | 'diamond'
    centerPoint: string
    endPoint: string
    aspectParam: string
    showWhen?: Record<string, string | string[]>
  }
  ```
- `GizmoConfig`: add `aspectHandles?: GizmoAspectHandle[]`, `outline?: GizmoOutline`.

**Overlay (`PreviewGizmoOverlay.tsx`):**
- Marker shapes: circle = current (rounded-full div); `diamond` = same box `rotate-45`; `square` = same box, not rounded. Apply per point/handle `shape`.
- Aspect handle: compute center screen `Cs` and endpoint screen `Es` (from their points' px via existing pointPxToScreen). `dir = normalize(Es - Cs)`; `perp = (-dir.y, dir.x)`; `L = |Es - Cs|`; handle screen pos = `Cs + perp * aspect * L`. `aspect` read from `currentParams[aspectParam] ?? definitionDefault ?? 1`. On drag: `aspect = dot(cursorScreen - Cs, perp) / max(L, 1e-6)`, clamp ≥ 0.05; `updateNodeData` writes the scalar aspectParam. Robust window-listener drag (reuse the point-drag lifecycle).
- Outline (SVG under handles): ellipse = `<ellipse cx cy rx=L ry=aspect*L transform=rotate(angle Cs)>`; diamond = `<polygon>` of the 4 tips `Cs ± dir*L`, `Cs ± perp*aspect*L`. Stroke indigo (`var(--indigo)`), ~1px, no fill, pointer-events-none.
- Respect `showWhen` for aspect handles + outline like points.

- [ ] Steps: add types; render marker shapes; render aspect handle w/ derived pos + scalar drag; render outline; `tsc`/`lint` clean. Commit `feat: gizmo marker shapes + perpendicular aspect handle + shape outline`.

---

### Task 2: Gradient — aspect field math + gizmo (radial / angular / diamond)

**Files:** `src/nodes/pattern/gradient.ts`

**Params:** add shared `aspect` (float, default 1, min 0.1, max 10, step 0.01, connectable, uniform, `showWhen:{ drawMode:'pinned', gradientType:['radial','angular','diamond'] }`).

**gizmo config:**
- Markers: `shape:'diamond'` on center `c` and each endpoint (radial `e`, angular `r`, diamond `k`); Linear `a`/`b` stay `shape:'circle'`.
- `aspectHandles`: one per aspect type, `shape:'square'`, `aspectParam:'aspect'`, `centerPoint:'c'`, `endPoint:'e'|'r'|'k'`, gated by its `gradientType` (+ `drawMode:'pinned'`).
- `outline`: radial → `ellipse` (c,e); angular → `ellipse` (c,r) [the "circle"]; diamond → `diamond` (c,k). Each `aspectParam:'aspect'`, gated by type.

**Field math (both backends), pinned.** With `C`=center, `P`=endpoint (radial E / angular R / diamond K), `A`=aspect:
```
u = P - C; L = max(length(u), 1e-6); uh = u / L; vh = vec2(-uh.y, uh.x);
d = coords - C; a = dot(d, uh) / L; b = dot(d, vh) / (A * L);
radial:  t = length(vec2(a, b));
diamond: t = abs(a) + abs(b);
angular: ang = atan(b, a);           // atan2; 0 along +u (the center→R line)
         t = ang * (1.0/6.28318530718);
         t = t < 0.0 ? t + 1.0 : t;  // 0..1, seam (t 0↔1) exactly on center→R line
```
Angular's seam sitting on `+u` makes the **center→R line align to the gradient's start/stop** (the requirement). Aspect makes angular's iso-angle frame elliptical (matches the ellipse outline). Feed `t` through the existing stops chain (unchanged). WGSL: per-component vec2 ops only; use the WGSL `atan2` builtin (GLSL `atan(y,x)`).

- [ ] Steps: add `aspect` param + gizmo (markers/aspectHandles/outline); implement radial+diamond aspect field GLSL+IR; `tsc`/`verify-ir-poc`/`validate-wgsl-multipass`/`lint` green (update gradient fixtures if needed, loose-mode). Commit `feat: gradient — elliptical radial + aspect diamond, aspect gizmo + outline`.

---

### Task 3 (controller live-verify, not a subagent)
On WebGPU: radial shows an ellipse outline; dragging the aspect handle squashes/stretches the ellipse and the shader field matches the outline (t=1 on the outline); endpoint sits on the visible extent along the primary axis; diamond likewise; markers render (diamond center/endpoint, square aspect); anchor-invariance + live-follow still hold. Docs update folded in if time.
