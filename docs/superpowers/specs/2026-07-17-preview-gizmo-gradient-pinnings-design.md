# Preview Gizmo Framework + Gradient Pinnings

**Date:** 2026-07-17
**Status:** design (awaiting review)
**Scope:** A reusable, Figma-backed **preview-overlay gizmo** framework (draggable control points on the live preview) + **Gradient** as its first consumer (Stretch / Pinned draw modes).

## Goal

1. Build a **standalone, robust, reusable gizmo framework**: draggable control-point handles rendered over the main preview, mapping screen↔shader coordinates and writing to node params. Any node can opt in by declaring control points; it will be extended to other nodes later — so it must NOT be gradient-specific.
2. Make **Gradient** its first consumer: a `Draw Mode` enum (`Stretch` | `Pinned`), where Pinned exposes per-type control points that are draggable on the preview (and numerically editable / wireable).

## Governing principles

- **Reusable first.** The gizmo is a framework primitive (like `spatial`/SRT). Nodes declare a `gizmo` config; the overlay renders generically. No gradient logic in the gizmo component.
- **Robust drag.** Move/up/cancel bound on `window` for the drag lifetime (never rely on pointer capture) — same release-safety pattern as the fixed crop gizmo ([[image-data-not-persisted]] session). Handles never strand a drag.
- **Figma is the source of truth** for the gizmo's visuals. Author the handle / center-marker / connector-line components (and any tokens) in Figma via **grip** first, backfill `tokens/sombra.ds.json`, `npm run tokens`, wire `ds.*`. See [[grip-figma-bridge]].
- **SRT transforms the modes.** The framework SRT coord injection stays; the draw mode is computed on the already-SRT-transformed coords, so Scale/Rotate/Offset compose on top of Stretch or Pinned.
- **WebGPU first, both backends.** Author field math in WGSL (`ir/wgsl-backend`), mirror to both GLSL paths, keep parity. See [[webgpu-first-both-backends]].
- **Pixels via `u_dpr * u_ref_size`** — control-point params are CSS px in the same space as the Offset (translate) params, so they're resize-stable.

## Part 1 — Gizmo framework

### Node-facing API
Optional `gizmo` on `NodeDefinition`:
```ts
interface GizmoPoint {
  id: string                              // unique within the node
  xParam: string                          // node param id holding X (px, relative to anchor)
  yParam: string                          // node param id holding Y (px)
  role?: 'point' | 'center'               // visual style
  showWhen?: Record<string, string | string[]>  // e.g. { gradientType: 'linear' }
}
interface GizmoConfig {
  points: GizmoPoint[]
  connectors?: Array<{ from: string; to: string }>  // draw a line between two point ids
  showWhen?: Record<string, string | string[]>      // gizmo active only in these param states (e.g. { drawMode: 'pinned' })
}
```
Points bind to plain float params (px), so they are also editable in the param list and wireable — no separate storage.

### Overlay component (`PreviewGizmoOverlay`)
- Renders over the main preview surface (docked / floating / fullwindow — one shared overlay keyed to the active preview container), **only when** exactly one node is selected, that node has a `gizmo`, and its `gizmo.showWhen` matches the node's current params.
- Reads each visible point's `(xParam, yParam)` px values, maps **px → preview screen pixels**, renders a handle per point (+ connector lines). Dragging maps **screen → px** and writes the bound params via `updateNodeData` (uniform update mode → live, no recompile).
- **Coord mapping:** point px are relative to `u_anchor`, in the same units as translate; screen mapping uses the preview canvas rect + `u_dpr`, `u_ref_size`, `u_anchor`, `u_resolution` (exposed for the selected node's last render). Inverse of the `auto_uv` pixel mapping.
- **Drag:** `pointerdown` on a handle → `dragging` state → `window` `pointermove`/`pointerup`/`pointercancel` for the lifetime, torn down on release. `nodrag`/`nowheel`. No `setPointerCapture`.
- Handles/markers/connector use **Figma-authored** `ds.*` styles.

### Figma assets (grip, first)
Author in Figma → DB → `ds.ts`:
- `gizmoHandle` (draggable point: default / hover / active), `gizmoCenter` (center marker, distinct shape), `gizmoConnector` (line stroke). Bind to existing tokens (indigo accent, edge, surface) where possible; new tokens only if unavoidable. Run `tokens:audit` for parity.

## Part 2 — Gradient consumer

### Params (added)
- `drawMode`: enum `stretch` | `pinned`, default `stretch`, `recompile`.
- Per-type control points as px float params (editable + wireable, `updateMode:'uniform'`), shown via `showWhen` on `drawMode:'pinned'` + the matching `gradientType`:
  - Linear: `ax,ay` (Point A), `bx,by` (Point B)
  - Radial: `cx,cy` (Center), `ex,ey` (Edge)
  - Angular: `cx,cy` (Center), `rx,ry` (Angle ref)  — reuse `cx,cy` across radial/angular/diamond
  - Diamond: `cx,cy` (Center), `kx,ky` (Corner)
- `gizmo` config with the points above (role center for `c*`), connectors (A–B for linear; Center–Edge/ref/corner otherwise), `showWhen:{ drawMode:'pinned' }`.

### Field math (both backends, per mode)
- **Stretch:** compute the existing per-`gradientType` field but in **normalized `v_uv` (0→1)** space instead of isotropic `auto_uv` — fills/stretches with aspect. (SRT still injected on the coords.)
- **Pinned:** convert control-point px → coord units (`/(u_dpr*u_ref_size)`, offset by `u_anchor`); compute the field from the points:
  - Linear: `t = dot(coords−A, B−A) / dot(B−A, B−A)`
  - Radial: `t = length(coords−C) / length(E−C)`
  - Angular: `t = atan2` of `coords−C` relative to `ref−C`, normalized 0..1
  - Diamond: `t = (|dx|+|dy|)` in the C→corner-scaled frame
- Feed `t` through the existing Stops mix-chain → `color`; `value = t` (clamped where the current code clamps).

## Backward compatibility

- Existing gradient graphs gain `drawMode` defaulting to **stretch** — their look changes from today's isotropic fill to stretched fill (accepted; consistent with the pattern-node overhaul). Pinned points default to sensible canvas-relative positions (e.g. A = left-center, B = right-center) so switching to Pinned looks reasonable immediately.
- Gradient keeps `color` + `value` outputs and the Stops editor.

## System-wide touchpoints

- New `gizmo` field in `NodeDefinition` (`src/nodes/types.ts`); overlay component; wire into the preview host(s).
- Figma components + DB + `ds.ts` (`tokens`, `tokens:audit`).
- `gradient.ts` (both `glsl`/`ir`), parity via `verify-ir-poc` + `validate-wgsl-multipass`.
- Docs: `BROWSER-AUTOMATION.md` (gradient params, gizmo dev-bridge notes if any), `NODE_AUTHORING_GUIDE.md` (new `gizmo` authoring section), node-templates.

## Out of scope (now)

- Applying the gizmo to nodes other than gradient (framework is built for it; wiring other nodes is later).
- Rotating/bezier control handles; only point positions.
- Snapping/guides.

## Open questions resolved

- Draw modes: Stretch (default) + Pinned. SRT transforms the mode's output. ✓
- Control points: draggable on preview + numeric-editable/wireable. ✓
- Types: all four. ✓
- Gizmo: standalone reusable framework, Figma-authored, robust drag. ✓
