# Zoom Bar

## Overview

| Field | Value |
|---|---|
| Figma ID | `17:314` |
| Figma Page | Molecules |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/zoom-slider.tsx` |
| React Component | `<ZoomSlider />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=17:314) |

## Figma Screenshot

Horizontal bar with: minus button, slider track with thumb, plus button, "100%" label, fit-to-screen button.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Slider width | 140px | `w-[140px]` | ✅ |
| Thumb size | 16px | shadcn Slider thumb | ✅ |
| Track height | 6px | shadcn Slider track | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | (primary-foreground) | — | `bg-primary-foreground` | ✅ |
| Text | (foreground) | — | `text-foreground` | ✅ |
| Track bg | `#252538` | surface/raised | shadcn track | ✅ |
| Track fill | `#6366f1` | indigo/default | shadcn range | ✅ |
| Thumb | `#ffffff` | white | shadcn thumb | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Gap | 4px | spacing/xs (`17:915`) | `gap-1` (4px) | ✅ |
| Padding | 4px | spacing/xs (`17:915`) | `p-1` (4px) | ✅ |
| Direction | horizontal | — | `flex-row` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 8px | radius/md (`17:923`) | `rounded-md` (8px) | ✅ |

## Children

- Minus button (Lucide `Minus` icon, ghost variant)
- shadcn Slider (track + thumb, 140px)
- Plus button (Lucide `Plus` icon, ghost variant)
- Percentage label ("100%", tabular-nums)
- Fit-to-screen button (Lucide `Maximize` icon)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `17:314`
- **React:** `<ZoomSlider position="bottom-center" />`
- **File:** `src/components/zoom-slider.tsx`

## Parity: ✅ Match

Layout, colors, slider dimensions, and button arrangement all match. The component wraps React Flow's `<Panel>` for positioning.
