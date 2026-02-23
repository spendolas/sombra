# Labeled Handle

## Overview

| Field | Value |
|---|---|
| Figma ID | `37:181` |
| Figma Page | Molecules |
| Type | COMPONENT_SET |
| Variants | 16: position (left/right) x portType (8) |
| React File | `src/components/labeled-handle.tsx` |
| React Component | `<LabeledHandle />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=37:181) |

## Figma Screenshot

Two rows of 8 variants each:
- **Top row** (position=left): Handle on left, "Label" text on right — 8 port type colors
- **Bottom row** (position=right): "Label" text on left, Handle on right — 8 port type colors

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL parent | flex container | ✅ |
| Height | auto (hug) | auto | ✅ |

### Colors

| Property | Figma | Code | Match |
|---|---|---|---|
| Label text | `#e8e8f0` (fg/default via `text-foreground`) | `text-foreground` | ✅ |
| Handle border | per port type | `handleColor` prop | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Gap (handle ↔ label) | 12px | spacing/lg (`17:918`) | `px-3` (12px padding on label) | ✅ |
| Direction (left) | row | — | `flex-row` | ✅ |
| Direction (right) | row-reverse | — | `flex-row-reverse justify-end` | ✅ |
| Label text-align (right) | RIGHT | — | `text-right` | ✅ |
| Label sizing | FILL | — | `flex-1` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Font size | 12px | `text-xs` (via `labelClassName`) | ✅ |

## Children

- 1x Handle atom instance (portType + connected overridable)
- 1x Text label

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `37:181`
- **React:** `<LabeledHandle type="source" position={Position.Right} id={id} title={label} handleColor={getPortColor(type)} connected={isConnected} />`
- **File:** `src/components/labeled-handle.tsx`

## Parity: ✅ Match

All 16 variants match. Left/right positioning, label alignment, handle colors, and spacing are all consistent between Figma and code.
