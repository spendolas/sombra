# Graph Toolbar

## Overview

| Field | Value |
|---|---|
| Figma ID | `268:1427` |
| Figma Page | Components (Molecules) |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/GraphToolbar.tsx` |
| React Component | `<GraphToolbar />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=268:1427) |

## Figma Screenshot

Horizontal pill with two icon buttons: Save (download arrow) and Open (upload arrow).

## Properties

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#1a1a2e` | surface/alt (`106:4`) | `bg-surface-alt` | ✅ |
| Icon color | `#b8b8c8` | fg/dim (`106:8`) | `text-fg-dim` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Gap | 4px | spacing/xs (`106:27`) | `gap-xs` | ✅ |
| Padding | 4px | spacing/xs (`106:27`) | `p-xs` | ✅ |
| Direction | horizontal | -- | `flex-row` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 8px | radius/md (`106:35`) | `rounded-md` | ✅ |

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Button size | 24x24 | shadcn `size="icon"` (24x24) | ✅ |
| Overall | 60x32 (hug) | hug contents | ✅ |

## Children

- Save button — instance of `Plus Minus Button` (Icon=download, Style=ghost, State=enabled)
- Open button — instance of `Plus Minus Button` (Icon=folder-open, Style=ghost, State=enabled)

## Code Connect

- **Figma Node:** `268:1427`
- **React:** `<GraphToolbar />`
- **File:** `src/components/GraphToolbar.tsx`

## Parity: ✅ Match

Layout, colors, spacing, and radius all match. The component wraps React Flow's `<Panel position="top-left">` for positioning. Save triggers `.sombra` file download, Open triggers file picker and graph load.
