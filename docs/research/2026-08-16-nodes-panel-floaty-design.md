# Floaty Nodes panel + Properties deprecation — design

**Date:** 2026-08-16 · **Branch:** `feat/nodes-panel-floaty` · **Status:** approved (sandbox signed off), implementing Phase B

## Goal

Retire the two side columns of the editor. The Properties panel is dead weight
(everything it edited already renders inline on the node). The Nodes palette
becomes a **floaty, toggleable overlay** anchored to the canvas region, clustered
left of the main actions pill — mirroring the PreviewToolbar two-group pattern.

Sandbox (`src/pages/EditorChromeSandbox.tsx`, `/editor-chrome-sandbox.html`) is
signed off. This doc covers the production swap.

## Decisions (locked)

- **Panel behavior:** pinned open (toggle to close), **default OFF**.
- **Panel contents:** relocate + reskin the existing category list only. No search (Cmd+K covers it).
- **Properties panel:** **archive** — move `PropertiesPanel.tsx` out of `src/` into `/archive` (repo root, excluded from `tsconfig` `include:["src"]`, so not compiled/linted), with a restore note. Strip its mount from `App.tsx` and its import + 2 cells from `DSPreview.tsx`. Leave `ds.propertiesPanel` token dormant (removing a DS component = a Figma-source edit → separate DS task; note in `.claude/ds-queue.md`).
- **Toggle icon:** owned `squareMousePointer` (added via `icons:add`; Figma DS mirror still owed — see Tasks).

## Verified facts

- React Flow **v12.10.0**. `FitViewOptions.padding` accepts a **per-side object**: `{ top, right, bottom, left, x, y }` each `PaddingWithUnit` (`` `${number}px` `` | `` `${number}%` `` | number). Source: `@xyflow/system/.../general.d.ts:121-129`. → panel-region exclusion is native padding, no manual viewport math.
- `fitView` call sites to make panel-aware: `FlowCanvas.tsx:41` (init), `GraphToolbar.tsx:44` (after Open file), `zoom-slider.tsx:75` (fit button). `DSPreview.tsx` is the DS page — leave it.
- `settingsStore` is `persist`-wrapped (localStorage key `sombra-settings`). Adding a field auto-persists. The store lists actions in BOTH the `SettingsState` interface and the `SettingsActions` type, and defaults live in `DEFAULT_SETTINGS` (`Omit<SettingsState, keyof SettingsActions>`) — a new field/action must be added in all the matching places.
- `ShaderNode.tsx:383-537` already renders params + `definition.component` + `BackgroundModeControl` inline → Properties panel is functionally redundant. Only live consumers: `App.tsx`, `DSPreview.tsx`.
- FlowCanvas mounts `GraphToolbar` + `ZoomSlider` + `MiniMap` as React Flow `<Panel>`/children inside `<ReactFlow>`.

## Layout changes

`App.tsx` (`ResizablePanelGroup direction="horizontal"`): today = `palette(12%) | center | properties(12%)`. **After:** drop both side `ResizablePanel`s + their `ResizableHandle`s; the center content becomes the whole row (the inner canvas/preview split stays untouched). `NodePalette` no longer mounts here.

New **`NodesPanelOverlay.tsx`** mounted inside `FlowCanvas` (replaces the direct `<GraphToolbar/>`). Structure — one top-left React Flow `<Panel>`, `flex-col gap-md items-start`:
- Row (`ds.previewToolbar.wrapper`): `[toggle pill: squareMousePointer]` (its own `previewToolbar.root` group) + the actions group.
- Below (when open): the floaty card wrapping the real `<NodePalette/>` — `bg-surface-raised rounded-xl border-edge-card shadow-2xl p-lg`, height-capped with internal scroll; canvas shows around/under it.

`GraphToolbar` refactor (minimal): render its inner pill (`ds.graphToolbar.root` + buttons) and its modals, but **not** its own `<Panel>` wrapper — the overlay owns the single top-left Panel and places the actions group in the cluster row. Keeps one corner cluster (no two overlapping top-left Panels).

## Focus/fit exclusion (note 3)

Shared helper `getFitViewPadding(nodesPanelOpen)` → `Padding`:
- open: `{ left: '<NODES_PANEL_LEFT>px', top: '<CLUSTER_TOP>px', right: '48px', bottom: '48px' }` where `NODES_PANEL_LEFT` = card inset + card width + gap (≈ 16 + 212 + 24 = **252px**).
- closed: `0.2` (current behavior).
Wire into the three call sites. Constants (`NODES_PANEL_WIDTH`, insets) live beside the overlay so card and padding cannot drift.

## Tasks / commits (one concern each)

1. `settingsStore`: add persisted `nodesPanelOpen` (default `false`) + `setNodesPanelOpen`/`toggleNodesPanel`.
2. `NodesPanelOverlay` + `GraphToolbar` de-Panel refactor; mount in FlowCanvas; remove side columns from `App.tsx`.
3. fitView padding helper + wire 3 sites.
4. Archive Properties panel: move file → `/archive`, strip `App.tsx` + `DSPreview.tsx`, add `.claude/ds-queue.md` note.
5. Figma: mirror `squareMousePointer` into DS icon set (306:236, 1.5 stroke) via grip.
6. (sandbox stays as a throwaway dev harness; not shipped — leave or delete at the end.)

## Verify

`npm run lint`; `npm run icons:gen:check`; dev smoke — toggle persists across reload, default off; drag a node from the floaty card onto canvas; fit button + Open-file framing keep nodes clear of the panel when open; preview dock left/right still correct; Properties gone; no console errors; WebGL2 path unaffected (layout-only).
