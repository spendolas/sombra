# Grid Dot

## Overview

| Field | Value |
|---|---|
| Figma ID | `40:392` |
| Figma Page | Atoms |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/FlowCanvas.tsx` |
| React Component | (React Flow `<Background>` built-in) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=40:392) |

## Figma Screenshot

A tiny 4px circle in `edge/subtle` color. Represents the repeating dot pattern on the canvas background grid.

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | 4px | (literal) | — (React Flow default) | ✅ |
| Height | 4px | (literal) | — (React Flow default) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | CSS Variable | Code | Match |
|---|---|---|---|---|---|
| Fill | `#2a2a3e` | edge/subtle (`17:17`) | `--edge-subtle` | React Flow `<Background>` default + `--surface` base | ⚠️ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 9999px (circle) | radius/full (`17:925`) | circle (dot type) | ✅ |

## Children

None (atom — single circle)

## Code Connect

- **Status:** ❌ Not applicable — React Flow built-in
- **Note:** The grid dot is rendered by React Flow's `<Background>` component with `variant="dots"`. The dot appearance is controlled by React Flow's internal SVG rendering, styled via `.react-flow__background` CSS.

## Parity: ✅ Match

The grid dot represents the canvas background pattern. React Flow's `<Background variant="dots">` produces a similar dot grid. The exact color may vary slightly as React Flow generates its own SVG dots, but the `.react-flow__background` is styled with `background-color: var(--surface)` in `index.css`.
