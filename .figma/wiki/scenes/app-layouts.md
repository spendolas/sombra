# App Layouts (Scene Templates)

## Overview

5 scene templates on the Figma Scenes page, each showing a complete app layout at 1440×900. They document the four preview modes and the default node graph.

**Figma Page:** Scenes (within Templates page section)
**React File:** `src/App.tsx`

## Scenes

### 1. Default Graph (`40:17910`)

**Figma URL:** [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=40:17910)

Default test graph: Time → Noise → Color Ramp → Fragment Output. Demonstrates the basic node wiring pattern. Uses auto-layout via `layoutGraph()`.

| Property | Value |
|---|---|
| Nodes | Time, Noise, Color Ramp, Fragment Output |
| Edges | 3 (Time→Phase, Noise.value→Color Ramp.value, Color Ramp.color→Fragment Output.color) |
| Edge colors | float (#d4d4d8), float (#d4d4d8), vec3 (#60a5fa) |

---

### 2. Sombra App — Docked Vertical (`40:19498`)

**Figma URL:** [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=40:19498)

Primary app layout with vertical split (canvas top, preview bottom).

| Property | Figma | Code (`App.tsx`) | Match |
|---|---|---|---|
| Overall layout | 3-panel horizontal | `ResizablePanelGroup direction="horizontal"` | ✅ |
| Left panel (palette) | 12% | `defaultSize="12%"` | ✅ |
| Center panel | 64% | `defaultSize="64%"` | ✅ |
| Right panel (properties) | 12% | `defaultSize="12%"` | ✅ |
| Center split | vertical (top/bottom) | `direction="vertical"` when `splitDirection="vertical"` | ✅ |
| Canvas portion | ~70% | `defaultSize={100 - splitPct}%` | ✅ |
| Preview portion | ~30% | `defaultSize={splitPct}%` | ✅ |
| Panel bg | `#1a1a2e` (surface/alt) | `bg-surface-alt` | ✅ |
| Panel padding | 16px | `p-4` | ✅ |
| Preview bg | `#000000` (black) | `bg-black` | ✅ |
| Toolbar position | inside preview, top-right | `absolute top-2 right-2` | ✅ |
| Toolbar active button | Rows2 (vertical split) | `isDockedV ? active : inactive` | ✅ |

---

### 3. Sombra App — Docked Horizontal (`86:1214`)

**Figma URL:** [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=86:1214)

Alternative docked layout with horizontal split (canvas left, preview right).

| Property | Figma | Code | Match |
|---|---|---|---|
| Center split | horizontal (left/right) | `direction="horizontal"` when `splitDirection="horizontal"` | ✅ |
| Toolbar active button | Columns2 | `isDockedH ? active : inactive` | ✅ |

---

### 4. Sombra App — Floating (`86:1527`)

**Figma URL:** [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=86:1527)

Full canvas with floating preview window overlaid.

| Property | Figma | Code | Match |
|---|---|---|---|
| Canvas | full center panel (no split) | single `<FlowCanvas>` | ✅ |
| Floating window | 400×300, bottom-right, rounded, shadow | `<FloatingPreview>` | ✅ |
| Toolbar active button | PictureInPicture2 | `previewMode === 'floating' ? active : inactive` | ✅ |
| Window features | drag, resize, border, shadow | `onDragStart`, `onResizeStart`, `border-edge`, `shadow-2xl` | ✅ |

---

### 5. Sombra App — Full Window (`86:1610`)

**Figma URL:** [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=86:1610)

Full black overlay covering entire viewport.

| Property | Figma | Code | Match |
|---|---|---|---|
| Overlay | full viewport, z-50 | `fixed inset-0 z-50 bg-black` | ✅ |
| Toolbar active button | Scan | `previewMode === 'fullwindow' ? active : inactive` | ✅ |
| Exit | — | Esc key → previous mode | ✅ (code-only) |

## Layout Architecture

```
App.tsx
├── ResizablePanelGroup (horizontal)
│   ├── ResizablePanel (palette, 12%)
│   │   └── NodePalette
│   ├── ResizablePanel (center, 64%)
│   │   ├── [docked] ResizablePanelGroup (vertical/horizontal)
│   │   │   ├── FlowCanvas (70%)
│   │   │   └── PreviewPanel (30%)
│   │   └── [floating/fullwindow] FlowCanvas (100%)
│   └── ResizablePanel (properties, 12%)
│       └── PropertiesPanel
├── [floating] FloatingPreview (fixed, z-40)
└── [fullwindow] FullWindowOverlay (fixed, z-50)
```

## Parity: ✅ All 5 scenes match

All panel ratios, colors, toolbar states, and layout modes match between Figma scenes and the running app.
