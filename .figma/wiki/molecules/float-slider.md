# Float Slider

## Overview

| Field | Value |
|---|---|
| Figma ID | `17:234` |
| Figma Page | Molecules |
| Type | COMPONENT_SET |
| Variants | 3: state (default / disabled / connected) |
| React File | `src/components/NodeParameters.tsx` |
| React Component | `<FloatSlider />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=17:234) |

## Figma Screenshot

Three variants stacked:
- **Default:** "Scale" label, "1.00" input, indigo slider track with white thumb
- **Disabled:** Same layout, 60% opacity, no interaction
- **Connected:** "Scale" label left, "← Noise" source label right

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | FILL | — | block-level div | ✅ |
| Slider track height | 6px | size/track-h (`43:3525`) | shadcn Slider (6px) | ✅ |
| Thumb size | 16px | size/thumb (`43:3524`) | shadcn Slider thumb (16px) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Label text | `#88889a` | fg/subtle (`17:14`) | `text-fg-subtle` | ✅ |
| Value text | `#5a5a6e` | fg/muted (`17:15`) | `text-fg-muted` (disabled) | ✅ |
| Track bg | `#252538` | surface/raised (`17:10`) | shadcn track | ✅ |
| Track fill | `#6366f1` | indigo/default (`17:18`) | shadcn range fill | ✅ |
| Thumb | `#ffffff` | white (`48:4147`) | shadcn thumb | ✅ |
| Input bg | `#252538` | surface/raised (`17:10`) | shadcn Input | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Label ↔ value gap | 6px | spacing/sm (`17:916`) | `space-y-1.5` row + flex between | ✅ |
| Stack gap | 6px | spacing/sm (`17:916`) | `space-y-1.5` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Label size | 10px | `text-[10px]` | ✅ |
| Value size | 10px | `text-[10px]` | ✅ |
| Value alignment | RIGHT | `text-right` on Input | ✅ |
| Value font | tabular-nums | `tabular-nums` | ✅ |

## Children

- Label text (fg/subtle)
- Number input (10px, right-aligned)
- shadcn Slider (track + thumb)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `17:234`
- **React:** `<FloatSlider param={param} value={value} onChange={fn} disabled={isConnected} />`
- **File:** `src/components/NodeParameters.tsx`

## Parity: ✅ Match

All three states match. Default shows interactive slider + number input. Disabled shows 60% opacity with non-interactive controls. Connected shows source label instead of controls.
