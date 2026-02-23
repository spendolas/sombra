# Node Palette

## Overview

| Field | Value |
|---|---|
| Figma ID | `39:289` |
| Figma Page | Organisms |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/NodePalette.tsx` |
| React Component | `<NodePalette />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=39:289) |

## Figma Screenshot

Vertical list of all 23 node types organized by 7 categories: COLOR, INPUT, MATH, NOISE, POST-PROCESS, OUTPUT. Each category has an uppercase header followed by palette item rows.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL parent | block-level div | ✅ |
| Height | auto (hug content) | auto | ✅ |

### Colors

| Property | Figma | Tailwind | Match |
|---|---|---|---|
| Background | transparent (inherits panel bg) | — | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Category gap | 12px | spacing/lg (`17:918`) | `space-y-3` (12px) | ✅ |
| Item gap | 4px | spacing/xs (`17:915`) | `space-y-1` (4px) | ✅ |

## Children (by category)

| Category | Node Count | Items |
|---|---|---|
| Color | 3 | Brightness/Contrast, HSV to RGB, Color Ramp |
| Input | 7 | UV Transform, Color, Number, Vec2, Time, Resolution, Random |
| Math | 7 | Arithmetic, Trig, Mix, Smoothstep, Remap, Turbulence, Ridged |
| Noise | 3 | Noise, FBM, Domain Warp |
| Post-process | 3 | Pixel Grid, Bayer Dither, Quantize UV |
| Output | 1 | Fragment Output |

**Total:** 24 items (23 node types + Fragment Output)

Each item is:
- 1x Category Header atom (per category)
- Nx Palette Item atoms (per node in category)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `39:289`
- **React:** `<NodePalette />`
- **File:** `src/components/NodePalette.tsx`

## Parity: ✅ Match

Categories, ordering, and item styling all match. The palette is populated dynamically from `nodeRegistry.getCategories()` in code, matching the static Figma layout.
