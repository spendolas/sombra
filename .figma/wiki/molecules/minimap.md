# MiniMap

## Overview

| Field | Value |
|---|---|
| Figma ID | — (styled via CSS in scene templates) |
| Figma Page | — (visible in Scenes) |
| Type | React Flow built-in |
| Variants | none |
| React File | `src/components/FlowCanvas.tsx` |
| React Component | React Flow `<MiniMap />` |
| Figma URL | — |

## Description

The canvas minimap overlay showing a bird's-eye view of all nodes. React Flow built-in component styled via CSS.

## Properties

### Colors

| Property | Figma | CSS Variable | Code | Match |
|---|---|---|---|---|
| Background | `#1a1a2e` | `--surface-alt` | `.react-flow__minimap { background: var(--surface-alt) }` | ✅ |
| Border | `#3a3a52` | `--edge` | `.react-flow__minimap { border: 1px solid var(--edge) }` | ✅ |

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Corner radius | 2px | React Flow default (~2px) | ✅ |

**Note:** MiniMap uses 2px radius which doesn't match any DS token (smallest is `radius/sm` = 4px). This is a justified exception — it's a React Flow built-in with its own border-radius.

## CSS Styling

From `src/index.css`:
```css
.react-flow__minimap {
  background: var(--surface-alt);
  border: 1px solid var(--edge);
}
```

## Code Connect

- **Status:** ❌ Not applicable — React Flow built-in
- **Note:** No Figma component exists. The minimap appears in scene templates as a styled rectangle.

## Parity: ✅ Match

Background and border colors match DS tokens. The 2px radius is a React Flow default (justified exception from the DS radius scale).
