# Properties Port Row

## Overview

| Field | Value |
|---|---|
| Figma ID | `37:206` |
| Figma Page | Molecules |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/PropertiesPanel.tsx` |
| React Component | (inline `<div>` in PropertiesPanel) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=37:206) |

## Figma Screenshot

Single row: "Coords" label on left (fg/dim), "float" type badge on right (fg/muted, mono).

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL | block-level div | ✅ |
| Height | auto (hug) | auto | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Label text | `#b8b8c8` | fg/dim (`17:13`) | `text-fg-dim` | ✅ |
| Type text | `#5a5a6e` | fg/muted (`17:15`) | `text-fg-muted` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Direction | horizontal (space-between) | `flex justify-between` | ✅ |
| Padding X | 8px | `px-2` | ✅ |
| Padding Y | 4px | `py-1` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Label size | 11px | `text-[11px]` | ✅ |
| Type font | mono | `font-mono` | ✅ |
| Type size | 11px | `text-[11px]` (inherited) | ✅ |

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Radius | 4px | `rounded` | ✅ |

## Children

- Port label text (fg/dim)
- Port type badge text (fg/muted, font-mono)

## Code Connect

- **Status:** ❌ Inline component
- **Code location:** `src/components/PropertiesPanel.tsx` lines 139-149 (inputs), 161-170 (outputs)

## Parity: ✅ Match

Row layout, colors, typography, and spacing all match between Figma and code.
