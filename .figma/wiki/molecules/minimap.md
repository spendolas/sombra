# MiniMap

## Overview

| Field | Value |
|---|---|
| Figma ID | `111:963` |
| Figma Page | Components (Molecules) |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/FlowCanvas.tsx` |
| React Component | React Flow `<MiniMap />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=111:963) |

## Description

The canvas minimap overlay showing a bird's-eye view of all nodes. React Flow built-in component styled with Sombra tokens.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | 200px | default React Flow MiniMap | ✅ |
| Height | 140px | default React Flow MiniMap | ✅ |

### Colors

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Background | #1a1a2e | surface/alt (VariableID:106:4) | `bgColor="var(--surface)"` + `style={{ backgroundColor: 'var(--surface-alt)' }}` | ✅ |
| Viewport mask | rgba(15,15,26,0.85) | surface/default at 85% | `maskColor="rgba(15, 15, 26, 0.85)"` | ✅ |
| Node rectangles | #6366f1 | indigo/default (VariableID:106:13) | `nodeColor="var(--indigo)"` | ✅ |
| Viewport border | #6366f1 | indigo/default (VariableID:106:13) | React Flow default | ✅ |
| Border | #2a2a3e | edge/subtle (VariableID:106:12) | — | ✅ |

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Corner radius | 8px | radius/md | ✅ |
| Clips content | true | true | ✅ |

## Children

1. **Viewport Mask** — Full-size rect, surface/default at 85% opacity
2. **Viewport Window** — 80x55 illustrative rect, indigo border, semi-transparent fill
3. **Node 1-5** — Small 16x10 rounded rects, fill indigo/default, scattered to suggest graph layout

## Code Connect

- **Figma Node:** `111:963`
- **React:** `<MiniMap nodeColor="var(--indigo)" maskColor="rgba(15, 15, 26, 0.85)" bgColor="var(--surface)" />`
- **File:** `src/components/FlowCanvas.tsx` (line 175)

## Parity: ✅ Match

Background, mask, node colors, and border all match DS tokens. Node positions are illustrative in Figma.
