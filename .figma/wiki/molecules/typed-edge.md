# Typed Edge

## Overview

| Field | Value |
|---|---|
| Figma ID | — (code-only; edges in scene templates use port-type-colored strokes) |
| Figma Page | — (visible in Scenes) |
| Type | Code component |
| Variants | 8 port type colors |
| React File | `src/components/TypedEdge.tsx` |
| React Component | `<TypedEdge />` |
| Figma URL | — |

## Description

A custom React Flow bezier edge that colors itself based on the source port's type. Not a standalone Figma component — edges appear as colored strokes in scene templates.

## Properties

### Colors (per port type)

| Port Type | Color | Source | Match |
|---|---|---|---|
| float | `#d4d4d8` | `PORT_COLORS.float` | ✅ |
| vec2 | `#34d399` | `PORT_COLORS.vec2` | ✅ |
| vec3 | `#60a5fa` | `PORT_COLORS.vec3` | ✅ |
| vec4 | `#a78bfa` | `PORT_COLORS.vec4` | ✅ |
| color | `#fbbf24` | `PORT_COLORS.color` | ✅ |
| sampler2D | `#f472b6` | `PORT_COLORS.sampler2D` | ✅ |
| fnref | `#22d3ee` | `PORT_COLORS.fnref` | ✅ |
| default | `#6b7280` | `PORT_COLORS.default` | ✅ |

### Dimensions

| Property | Default | Selected | Match |
|---|---|---|---|
| Stroke width | 1.5px | 2.5px | ✅ |
| Opacity | 0.7 | 1.0 | ✅ |

### Edge Data

| Field | Type | Description |
|---|---|---|
| `sourcePortType` | string | Port type of the source output, set in `onConnect` |

## Code

```tsx
const color = (portType && PORT_COLORS[portType]) ?? PORT_COLORS.default

<BaseEdge
  path={edgePath}
  style={{
    stroke: color,
    strokeWidth: selected ? 2.5 : 1.5,
    opacity: selected ? 1 : 0.7,
  }}
/>
```

## Figma Representation

Edges in Figma scene templates use **strokes bound to Port Types variables**. Each edge path in the Default Graph, Docked Vertical, etc. scenes has its stroke color bound to the appropriate port type variable (e.g., `Port Types/float` for float connections).

## Code Connect

- **Status:** ❌ Not applicable — no standalone Figma component
- **Note:** TypedEdge is registered as a custom edge type in React Flow via `edgeTypes={{ default: TypedEdge }}`

## Parity: ✅ Match

Edge colors in Figma scenes match `PORT_COLORS` exactly. Stroke widths and opacity in Figma scene strokes match the code values.
