# Palette Item

## Overview

| Field | Value |
|---|---|
| Figma ID | `17:248` |
| Figma Page | Atoms |
| Type | COMPONENT_SET |
| Variants | 2: state (default / hover) |
| React File | `src/components/NodePalette.tsx` |
| React Component | (inline `<div>`) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=17:248) |

## Figma Screenshot

Two side-by-side rectangles labeled "Noise":
- **Default:** darker background (`surface/raised`), dimmer text (`fg/dim`)
- **Hover:** lighter background (`surface/elevated`), brighter text (`fg/default`)

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | FILL | — | (block-level `<div>`) | ✅ |
| Height | auto (hug) | — | auto | ✅ |

### Colors

| Property (default) | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Text | `#b8b8c8` | fg/dim (`17:13`) | `text-fg-dim` | ✅ |
| Border | `#2a2a3e` | edge/subtle (`17:17`) | `border-edge-subtle` | ✅ |

| Property (hover) | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#2d2d44` | surface/elevated (`17:11`) | `hover:bg-surface-elevated` | ✅ |
| Text | `#e8e8f0` | fg/default (`17:12`) | `hover:text-fg` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Padding X | 8px | spacing/md (`17:917`) | `px-2` (8px) | ✅ |
| Padding Y | 6px | spacing/sm (`17:916`) | `py-1.5` (6px) | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Font size | 12px | `text-xs` (12px) | ✅ |
| Font weight | 400 (regular) | default | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 4px | radius/sm (`17:922`) | `rounded` (4px) | ✅ |
| Border width | 1px | (literal) | `border` | ✅ |

## Children

None (atom — text label only)

## Code Connect

- **Status:** ❌ Inline component (no named export)
- **Figma Node:** `17:248`
- **Code location:** `src/components/NodePalette.tsx` lines 25-33
- **JSX:**
```tsx
<div
  draggable
  onDragStart={(e) => onDragStart(e, node.type)}
  className="px-2 py-1.5 rounded text-xs cursor-move transition-colors bg-surface-raised text-fg-dim border border-edge-subtle hover:bg-surface-elevated hover:text-fg"
  title={node.description}
>
  {node.label}
</div>
```

## Parity: ✅ Match

Both states (default and hover) match exactly. Background, text color, padding, border, and radius all use the correct DS tokens.
