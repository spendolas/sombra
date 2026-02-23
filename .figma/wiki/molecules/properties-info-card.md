# Properties Info Card

## Overview

| Field | Value |
|---|---|
| Figma ID | `37:201` |
| Figma Page | Molecules |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/PropertiesPanel.tsx` |
| React Component | (inline `<div>` in PropertiesPanel) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=37:201) |

## Figma Screenshot

Compact card showing: "NOISE" category label (10px uppercase, fg/subtle), "Noise" node name (14px semibold, fg/default), and "noise · node_1" ID (10px mono, fg/muted). Separator between name and ID.

## Properties

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |
| Category text | `#88889a` | fg/subtle (`17:14`) | `text-fg-subtle` | ✅ |
| Name text | `#e8e8f0` | fg/default (`17:12`) | `text-fg` | ✅ |
| ID text | `#5a5a6e` | fg/muted (`17:15`) | `text-fg-muted` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Padding | 12px | spacing/lg (`17:918`) | `p-3` | ✅ |
| Separator margin | 8px | spacing/md (`17:917`) | `my-2` | ✅ |
| Category ↔ name gap | 4px | spacing/xs (`17:915`) | `mb-1` | ✅ |
| Name ↔ description gap | 8px | spacing/md (`17:917`) | `mb-2` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Category | 10px uppercase tracking-wide | `text-[10px] uppercase tracking-wide` | ✅ |
| Name | 14px medium | `text-sm font-medium` | ✅ |
| Description | 12px regular | `text-xs leading-relaxed` | ✅ |
| ID | 10px mono | `text-[10px] font-mono` | ✅ |

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Radius | 8px (radius/lg) | `rounded-lg` | ✅ |
| Border | 1px | `border border-edge` | ✅ |

## Children

- Category label
- Node name
- Description text (optional)
- Separator
- ID label (font-mono)

## Code Connect

- **Status:** ❌ Inline component
- **Code location:** `src/components/PropertiesPanel.tsx` lines 114-130

## Parity: ✅ Match

All text styles, colors, spacing, and border match exactly.
