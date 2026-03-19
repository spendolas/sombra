# React Flow CSS Override Report

**Date:** 2026-03-08
**Source:** `@xyflow/react@^12.10.0` (`node_modules/@xyflow/react/dist/style.css`, 625 lines)
**Target:** `src/index.css` lines 71-136

## Root Cause

`index.css` (Sombra) loads before `@xyflow/react/dist/style.css` (React Flow) due to import order:
- `main.tsx:3` — `import './index.css'`
- `App.tsx:4` — `import '@xyflow/react/dist/style.css'`

For same-specificity selectors, **React Flow wins the cascade**. Additionally, Sombra does not add the `.dark` class to `<ReactFlow>`, so RF uses **light-theme defaults** (`#fff` backgrounds, `#b1b1b7` strokes, white handle borders) as fallbacks.

## Fix Strategy

React Flow v12 provides CSS custom properties (`--xy-*`) consumed by its own selectors. Setting these on `.react-flow` works regardless of cascade position — no `!important` needed for most properties.

**Approach:** Single `.react-flow` block mapping all `--xy-*` variables to Sombra tokens, plus targeted direct overrides only where no CSS variable exists.

## CSS Variable Overrides (`.react-flow` block)

| CSS Variable | Sombra Token | Replaces RF Default |
|---|---|---|
| `--xy-edge-stroke` | `var(--edge)` | `#b1b1b7` (light gray) |
| `--xy-edge-stroke-width` | `2` | `1` |
| `--xy-edge-stroke-selected` | `var(--indigo)` | `#555` |
| `--xy-connectionline-stroke` | `var(--indigo-hover)` | `#b1b1b7` (light gray) |
| `--xy-connectionline-stroke-width` | `2` | `1` |
| `--xy-handle-background-color` | `var(--surface-elevated)` | `#1a192b` |
| `--xy-handle-border-color` | `var(--surface-alt)` | `#fff` (white!) |
| `--xy-node-color` | `var(--fg)` | `inherit` |
| `--xy-node-border` | `1px solid var(--edge-card)` | `1px solid #1a192b` |
| `--xy-node-background-color` | `var(--surface-elevated)` | `#fff` (white!) |
| `--xy-node-border-radius` | `var(--radius-md)` | `3px` |
| `--xy-node-boxshadow-hover` | `none` | `0 1px 4px 1px rgba(0,0,0,0.08)` |
| `--xy-node-boxshadow-selected` | `0 0 0 2px var(--indigo)` | `0 0 0 0.5px #1a192b` |
| `--xy-minimap-background-color` | `var(--surface-alt)` | `#fff` (white!) |
| `--xy-background-color` | `var(--surface)` | `transparent` |
| `--xy-selection-background-color` | `rgba(99, 102, 241, 0.08)` | `rgba(0, 89, 220, 0.08)` (blue) |
| `--xy-selection-border` | `1px dotted rgba(99, 102, 241, 0.5)` | `1px dotted rgba(0, 89, 220, 0.8)` (blue) |
| `--xy-attribution-background-color` | `transparent` | `rgba(255, 255, 255, 0.5)` |

## Direct Overrides (no CSS variable exists)

| Selector | Property | Value | Why |
|---|---|---|---|
| `.react-flow__node` | `font-size` | `13px` | RF doesn't set this; matches `text-handle` token |
| `.react-flow__handle` | `border-width` | `2px !important` | RF sets `1px` via `border` shorthand; no CSS var for width |
| `.react-flow__handle` | `width`, `height` | `var(--sz-handle) !important` | RF sets `6px`; `!important` needed to override |
| `.react-flow__node.selected > div` | `border-color`, `box-shadow` | `var(--indigo)` | Custom node type selector not in RF defaults |
| `.react-flow__minimap` | `border` | `1px solid var(--edge-subtle)` | RF has no border CSS; matches `ds.miniMap.root` token |
| `.react-flow__panel` | `margin` | `var(--sp-xl) !important` | RF sets `15px`; `!important` to override |
| `.react-flow .react-flow__edge.updating .react-flow__edge-path` | `stroke` | `var(--indigo-hover)` | RF hardcodes `#777`; bumped specificity to win cascade |

## Rules Removed (replaced by CSS variables)

| Old Rule | Replaced By |
|---|---|
| `.react-flow__edge-path { stroke; stroke-width }` | `--xy-edge-stroke` + `--xy-edge-stroke-width` |
| `.react-flow__edge.selected .react-flow__edge-path { stroke; stroke-width }` | `--xy-edge-stroke-selected` |
| `.react-flow__handle { border: 2px solid var(--surface-alt) }` | `--xy-handle-border-color` + `border-width: 2px !important` |
| `.react-flow__minimap { background }` | `--xy-minimap-background-color` |
| `.react-flow__background { background-color }` | `--xy-background-color` |

## Additional Fixes

| File | Change | Reason |
|---|---|---|
| `FlowCanvas.tsx:182` | `bgColor="var(--surface)"` changed to `var(--surface-alt)` | Prop sets `--xy-minimap-background-color-props` which overrides CSS variable. Was using wrong token (`--surface` instead of `--surface-alt` per `ds.miniMap.root`). |

## Accepted: MiniMap Mask Color

`FlowCanvas.tsx:181`: `maskColor="rgba(15, 15, 26, 0.85)"` — hardcoded RGBA derived from `--surface` (#0f0f1a) at 85% opacity. The `--overlay-scrim` token (#000000) is fully opaque, so this alpha value must be hardcoded. Accepted as intentional.

## Browser Verification Results

| Check | Element | Expected | Actual | Status |
|---|---|---|---|---|
| 1 | Handle size | 12px | 12px | PASS |
| 2 | Handle border-width | 2px | 2px | PASS |
| 3 | Handle border-color | port-type color (inline) | port-type color | PASS |
| 4 | Edge stroke | port-type color (TypedEdge inline) | port-type color | PASS |
| 5 | Minimap background | `#1a1a2e` (surface-alt) | `rgb(26, 26, 46)` | PASS |
| 6 | Minimap border | `#2a2a3e` (edge-subtle) | `rgb(42, 42, 62)` | PASS |
| 7 | Background | `#0f0f1a` (surface) | `rgb(15, 15, 26)` | PASS |
| 8 | Panel margin | 16px | 16px | PASS |
| 9 | Selected node border | `#6366f1` (indigo) | `rgb(99, 102, 241)` | PASS |
| 10 | Selected node shadow | `0 0 0 2px indigo` | `rgb(99, 102, 241) 0px 0px 0px 2px` | PASS |
| 11 | Connection line stroke (CSS var) | `#818cf8` (indigo-hover) | `#818cf8` | PASS |
| 12 | Connection line width (CSS var) | `2` | `2` | PASS |
| 13 | Selection bg (CSS var) | `rgba(99,102,241,0.08)` | `rgba(99, 102, 241, 0.08)` | PASS |
| 14 | Selection border (CSS var) | `1px dotted rgba(99,102,241,0.5)` | match | PASS |
| 15 | Edge updating stroke | `var(--indigo-hover)` | Sombra selector wins (higher specificity) | PASS |
| 16 | Node font-size | 13px | 13px | PASS |
| 17 | `npm run build` | 0 errors | 0 errors | PASS |

## External CSS Audit

Only **one** external CSS source exists in the entire codebase:
- `@xyflow/react/dist/style.css` (React Flow)

All other dependencies are CSS-free:
- radix-ui: headless, zero CSS
- react-resizable-panels: inline styles only
- lucide-react: SVG components only
- clsx, tailwind-merge, pako, zustand, dagre: pure JS utilities
