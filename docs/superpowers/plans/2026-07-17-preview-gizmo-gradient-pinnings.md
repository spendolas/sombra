# Preview Gizmo Framework + Gradient Pinnings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable, Figma-backed preview-overlay gizmo (draggable control points on the live preview) + Gradient as its first consumer (Stretch / Pinned draw modes with per-type control points).

**Architecture:** Nodes declare an optional `gizmo` config on their `NodeDefinition`; a `PreviewGizmoOverlay` mounted over the active preview host renders draggable handles + connector lines for the selected node, maps screen↔shader coords, and writes bound px params. Gradient adds a `drawMode` enum and per-type control-point px params consumed by both the gizmo and the field codegen.

**Tech Stack:** React 19 + TS, @xyflow/react (selection), Zustand (graphStore/settingsStore), Figma via grip → `tokens/sombra.ds.json` → `ds.ts`, WGSL + GLSL codegen.

## Global Constraints

- **Reusable, not gradient-specific.** The gizmo type, overlay, and coord math live in framework locations (`src/nodes/types.ts`, `src/components/`, `src/utils/`) and reference no gradient concept. Gradient is one consumer.
- **Robust drag.** `pointerdown` on a handle → bind `pointermove`/`pointerup`/`pointercancel` on `window` for the drag lifetime, tear down on release; no `setPointerCapture`. (Mirror the fixed ImageUploader gizmo.)
- **Figma is source of truth** for gizmo visuals — author components in Figma via **grip** first, then `tokens/sombra.ds.json` → `npm run tokens` → `ds.ts`; verify with `npm run tokens:audit`. Reuse existing tokens (indigo/edge/surface); add new tokens only if unavoidable.
- **Coord mapping:** point params are **CSS px relative to the anchor** (same space as the SRT translate params). Screen position = anchor-screen-point ± pointPx on the preview canvas rect. Anchor = `anchorToVec2(fragment_output.anchor param)` (default center). Y sign follows the translate convention (`-tY`) — calibrate live so a dragged handle tracks the cursor 1:1. The shader's Pinned field converts px→coord units via `/(u_dpr * u_ref_size)`.
- **SRT transforms the modes**: the framework SRT coord injection stays; draw-mode field math runs on the already-transformed coords.
- **WebGPU first, both backends.** Author WGSL, mirror both GLSL paths, keep `glsl()`/`ir()` parity. Verify each codegen task: `npx tsc -b`, `npx tsx scripts/verify-ir-poc.ts`, `npx tsx scripts/validate-wgsl-multipass.ts`, `npm run lint`. Controller owns live browser verification (implementers run scripts only).
- Spec: `docs/superpowers/specs/2026-07-17-preview-gizmo-gradient-pinnings-design.md`.

## File Structure

- Create: `src/utils/gizmo-coords.ts` (pure px↔screen mapping), `src/components/PreviewGizmoOverlay.tsx`
- Modify: `src/nodes/types.ts` (GizmoConfig), preview hosts (`PreviewPanel.tsx`/`FloatingPreview.tsx`/`FullWindowOverlay.tsx` or a shared mount in `App.tsx`), `src/nodes/pattern/gradient.ts`, `tokens/sombra.ds.json`, `src/generated/ds.ts` (generated)
- Reference: `src/components/ImageUploader.tsx` (robust drag gizmo + clientToSvg mapping), `src/nodes/output/fragment-output.ts` (`anchorToVec2`), the DS colorPicker Figma flow in the prior ledger, `src/webgpu/renderer.ts:748-752` (uniform values / anchor).

---

### Task 1: Figma assets + DS tokens for gizmo visuals

**Files:** Figma (via grip) → `tokens/sombra.ds.json` → `src/generated/ds.ts`

**Interfaces:** Produces `ds.gizmo.{handle, handleHover, handleActive, center, connector}` class strings.

- [ ] **Step 1:** Author in Figma via grip: a `Gizmo` component set — `handle` (draggable point: default/hover/active states), `center` (distinct center marker), `connector` (line style). Bind to existing tokens (indigo accent for active, edge/surface for idle). Record node ids.
- [ ] **Step 2:** Backfill `tokens/sombra.ds.json` with a `gizmo` component (parts keyed by Figma node id, declarative fill/stroke/radius/size).
- [ ] **Step 3:** `npm run tokens` → regenerates `ds.ts` with `ds.gizmo.*`.
- [ ] **Step 4:** `npm run tokens:audit` → Figma↔DB parity clean; `npx tsc -b` + `npm run lint` clean.
- [ ] **Step 5:** Commit `feat(ds): gizmo handle/center/connector components (Figma-backed)`.

---

### Task 2: GizmoConfig type + coord-mapping utility

**Files:** Modify `src/nodes/types.ts`; Create `src/utils/gizmo-coords.ts`

**Interfaces:**
- Produces (types.ts):
```ts
export interface GizmoPoint {
  id: string
  xParam: string
  yParam: string
  role?: 'point' | 'center'
  showWhen?: Record<string, string | string[]>
}
export interface GizmoConfig {
  points: GizmoPoint[]
  connectors?: Array<{ from: string; to: string }>
  showWhen?: Record<string, string | string[]>
}
// add optional `gizmo?: GizmoConfig` to NodeDefinition
```
- Produces (gizmo-coords.ts): pure functions
```ts
// canvasRect: DOMRect of the preview <canvas>; anchor: [ax,ay] 0-1
export function pointPxToScreen(px: number, py: number, canvasRect: {left:number;top:number;width:number;height:number}, anchor: [number,number]): { x: number; y: number }
export function screenToPointPx(sx: number, sy: number, canvasRect: {...}, anchor: [number,number]): { x: number; y: number }
```
Mapping: `anchorScreen = (rect.left + anchor[0]*rect.width, rect.top + anchor[1]*rect.height)`; `screen = anchorScreen + (px, -py)` (Y up); inverse for `screenToPointPx`. (Y-sign to be confirmed live in Task 3.)

- [ ] **Step 1:** Add `GizmoPoint`/`GizmoConfig` + `gizmo?` on `NodeDefinition` in `types.ts`.
- [ ] **Step 2:** Write `gizmo-coords.ts` with the two pure mapping functions (round-trip inverse).
- [ ] **Step 3:** Add a round-trip assertion to `scripts/verify-ir-poc.ts` OR a tiny standalone check (`pointPxToScreen` then `screenToPointPx` returns the input) — follow the repo's script-test convention.
- [ ] **Step 4:** `npx tsc -b` + `npm run lint` clean; run the round-trip check.
- [ ] **Step 5:** Commit `feat: GizmoConfig type + px↔screen coord mapping util`.

---

### Task 3: PreviewGizmoOverlay component + mount

**Files:** Create `src/components/PreviewGizmoOverlay.tsx`; Modify the preview host(s) to mount it over the active preview canvas.

**Interfaces:** Consumes `gizmo-coords.ts`, `GizmoConfig`, graphStore (selected node + params + `updateNodeData`), the preview canvas rect, and the anchor (from the fragment_output anchor param via `anchorToVec2`).

Behavior:
- Active only when exactly one node is selected, it has `definition.gizmo`, and `gizmo.showWhen` matches its params.
- For each visible point (its `showWhen` matches), read `(xParam,yParam)` px → `pointPxToScreen` → render a handle (`ds.gizmo.handle`, `center` for role center). Draw `connectors` as SVG lines between mapped points.
- Drag: `pointerdown` on a handle → `dragging` state; `window` `pointermove` (→ `screenToPointPx` → `updateNodeData` on the bound params) / `pointerup` / `pointercancel` (clear); teardown on release. `nodrag nowheel`. No pointer capture.
- Overlay is an absolutely-positioned SVG covering the preview canvas; pointer-events only on handles.

- [ ] **Step 1:** Build `PreviewGizmoOverlay` (SVG overlay, handle + connector render, robust window-listener drag writing params).
- [ ] **Step 2:** Mount it over the active preview host (shared mount keyed to the current preview mode — docked/floating/fullwindow — reusing the same `targetRef`/canvas the renderer draws into; see `App.tsx:354`).
- [ ] **Step 3:** `npx tsc -b` + `npm run lint` clean.
- [ ] **Step 4 (controller live-verify):** with a temporary node exposing a gizmo, confirm handles render at the right spot, dragging tracks the cursor 1:1 (calibrate the Y sign in `gizmo-coords.ts` if inverted), release off-canvas ends the drag (no strand), and params update live. Remove the temp node.
- [ ] **Step 5:** Commit `feat: PreviewGizmoOverlay — reusable draggable control points on the preview`.

---

### Task 4: Gradient — Draw Mode + control-point params + gizmo config

**Files:** Modify `src/nodes/pattern/gradient.ts`

**Interfaces:** Adds params + `gizmo`; consumed by Task 5's codegen and by the overlay.

- `drawMode`: enum `stretch`|`pinned`, default `stretch`, `updateMode:'recompile'`.
- Control-point px params (float, `connectable:true, updateMode:'uniform'`, `showWhen:{ drawMode:'pinned', gradientType: <type> }`), defaults canvas-relative (A left-center, B right-center, etc.):
  - Linear: `ax,ay,bx,by`; Radial: `cx,cy,ex,ey`; Angular: `cx,cy,rx,ry`; Diamond: `cx,cy,kx,ky` (share `cx,cy` across radial/angular/diamond).
- `gizmo`: points binding those params (role `center` for `cx,cy`), connectors (A–B; C–E/C–ref/C–corner), `showWhen:{ drawMode:'pinned' }`.

- [ ] **Step 1:** Add `drawMode` + control-point params with `showWhen`, sensible px defaults.
- [ ] **Step 2:** Add the `gizmo` config referencing those params.
- [ ] **Step 3:** `npx tsc -b` + `npm run lint`.
- [ ] **Step 4 (controller live-verify):** select gradient, set Draw Mode = Pinned, pick each Type → correct handles appear and drag; numeric params edit the same points; Stretch mode hides the gizmo.
- [ ] **Step 5:** Commit `feat: gradient — Draw Mode + pinned control-point params + gizmo config`.

---

### Task 5: Gradient — Stretch + Pinned field math (both backends)

**Files:** Modify `src/nodes/pattern/gradient.ts` (`glsl` + `ir`)

**Core math** (read `drawMode`, `gradientType` at compile time; add `u_dpr`/`u_ref_size`/`u_anchor` uniforms for pinned; `u_resolution` for stretch aspect if needed):
- **Stretch:** compute the existing per-`gradientType` field in normalized `v_uv` (0→1) space instead of isotropic `auto_uv` (the compiler provides the `auto_uv`; for stretch use `v_uv` directly — see how `glsl-generator.ts` exposes `v_uv`).
- **Pinned:** convert each point px → coord units: `pt = anchor + vec2(px, -py)/(u_dpr*u_ref_size)`. Then:
  - Linear: `t = dot(coords - A, B - A) / max(dot(B - A, B - A), 1e-6)`
  - Radial: `t = length(coords - C) / max(length(E - C), 1e-6)`
  - Angular: `t = atan(cross, dotv) * (1/TAU) + 0.5` where the frame is `ref - C`
  - Diamond: project `coords - C` onto the C→corner frame, `t = |u| + |v|`
- Feed `t` through the existing Stops mix-chain → `color`; `value = t` (clamp per current code).

- [ ] **Step 1:** Implement Stretch (v_uv) for all four types, GLSL + IR.
- [ ] **Step 2:** Implement Pinned (px→coord conversion + the four field formulas), GLSL + IR, mirrored for parity (per-component vec2 ops for WGSL).
- [ ] **Step 3:** `npx tsc -b`, `npx tsx scripts/verify-ir-poc.ts`, `npx tsx scripts/validate-wgsl-multipass.ts`, `npm run lint` — all green (update the gradient fixture if needed, matching color_ramp's loose-mode approach).
- [ ] **Step 4 (controller live-verify, WebGPU):** Stretch fills/stretches with aspect; Pinned — dragging handles moves the gradient (linear A→B, radial center/edge, angular ref, diamond corner); SRT still transforms on top; stops recolor correctly.
- [ ] **Step 5:** Commit `feat: gradient — Stretch (normalized) + Pinned (control-point) field math`.

---

### Task 6: Docs

**Files:** Modify `NODE_AUTHORING_GUIDE.md`, `BROWSER-AUTOMATION.md`, `.figma/wiki/templates/node-templates.md`

- [ ] **Step 1:** Add a `gizmo` authoring section to `NODE_AUTHORING_GUIDE.md` (GizmoConfig shape, px-from-anchor convention, robust-drag note).
- [ ] **Step 2:** Update `BROWSER-AUTOMATION.md` gradient row (drawMode + control-point params) and note the overlay/selection behavior.
- [ ] **Step 3:** Update node-templates for gradient; `npm run lint`; commit `docs: gizmo authoring + gradient pinnings`.
```
