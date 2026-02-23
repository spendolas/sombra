# Preview Toolbar

## Overview

| Field | Value |
|---|---|
| Figma ID | `86:100` |
| Figma Page | Molecules |
| Type | COMPONENT_SET |
| Variants | 4: mode (docked-vertical / docked-horizontal / floating / fullwindow) |
| React File | `src/components/PreviewToolbar.tsx` |
| React Component | `<PreviewToolbar />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=86:100) |

## Figma Screenshot

4 pill-shaped toolbar variants stacked vertically, each with 4 icon buttons (Rows2, Columns2, PictureInPicture2, Scan). One button is highlighted in indigo per variant, indicating the active mode.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | auto (hug) | auto | ✅ |
| Height | auto (hug) | auto | ✅ |
| Icon size | 16×16 | Lucide default (16px in icon-xs context) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Text (inactive) | `#b8b8c8` | fg/dim (`17:13`) | `text-fg-dim` | ✅ |
| Active button bg | `#6366f1` | indigo/default (`17:18`) | `bg-indigo` | ✅ |
| Active button text | `#e8e8f0` | fg/default (`17:12`) | `text-fg` | ✅ |
| Hover bg | `#2d2d44` | surface/elevated (`17:11`) | `hover:bg-surface-elevated` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Gap (between buttons) | 6px | spacing/sm (`17:916`) | `gap-1.5` (6px) | ✅ |
| Padding X | 8px | spacing/md (`17:917`) | `px-2` (8px) | ✅ |
| Padding Y | 4px | spacing/xs (`17:915`) | `py-1` (4px) | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Text size | 12px | `text-xs` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 4px | radius/sm (`17:922`) | `rounded` (4px) | ✅ |

## Children

- 4x Icon button instances (Rows2, Columns2, PictureInPicture2, Scan)
- Icons from Foundations page (Lucide vectors)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `86:100`
- **React:** `<PreviewToolbar className={className} />`
- **File:** `src/components/PreviewToolbar.tsx`
- **Icons:** `Rows2`, `Columns2`, `PictureInPicture2`, `Scan` from `lucide-react`

## Parity: ✅ Match

All 4 mode variants match. Active state uses `bg-indigo text-fg`, inactive uses `text-fg-dim` with hover effects. Button sizing uses `icon-xs` variant from shadcn Button.
