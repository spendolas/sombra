# Gradient Editor

## Overview

| Field | Value |
|---|---|
| Figma ID | `50:4208` |
| Figma Page | Molecules |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/ColorRampEditor.tsx` |
| React Component | `<ColorRampEditor />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=50:4208) |

## Figma Screenshot

Compact gradient editor with: gradient preview bar (dark-to-light), stop marker row, controls row (color swatch, "50%", +/- buttons), and preset dropdown ("Cobalt Drift").

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Gradient bar height | 24px (size/swatch) | `h-6` (24px) | ✅ |
| Stop marker size | 12px (size/handle) | `w-3 h-3` (12px) | ✅ |
| Color swatch | 24×24 (size/swatch) | `w-6 h-6` | ✅ |
| +/- buttons | 20×20 (size/button-sm) | `w-5 h-5` | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Bar border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |
| Stop marker border | `#2d2d44` | surface/elevated (`17:11`) | `border-surface-elevated` | ✅ |
| Selected ring | `#6366f1` | indigo/default (`17:18`) | `ring-indigo` | ✅ |
| Position text | `#b8b8c8` | fg/dim (`17:13`) | `text-fg-dim` | ✅ |
| +/- button bg | `#1a1a2e` | surface/alt (`17:9`) | `bg-surface-alt` | ✅ |
| +/- button text | `#e8e8f0` | fg/default (`17:12`) | `text-fg` | ✅ |
| Preset trigger bg | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Preset trigger text | `#e8e8f0` | fg/default (`17:12`) | `text-fg` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Stack gap | 8px (spacing/md) | `space-y-2` (8px) | ✅ |
| Controls gap | 8px | `gap-2` | ✅ |
| Stop markers row height | 16px | `h-4` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Bar radius | 8px | radius/md (`17:923`) | `rounded-md` | ✅ |
| Stop radius | 9999px | radius/full (`17:925`) | `rounded-full` | ✅ |
| Swatch radius | 4px | radius/sm (`17:922`) | `rounded` | ✅ |
| Preset trigger radius | (shadcn default) | — | shadcn Select | ✅ |

## Children

- Gradient bar (`<div>` with `linear-gradient` background)
- Stop markers row (absolute-positioned `<button>` circles)
- Controls row: color swatch, position label, spacer, +/- buttons
- Preset selector (shadcn Select with 6 presets)

## Presets

| Preset | Stops |
|---|---|
| Cobalt Drift | 5 stops: dark navy → cobalt blue → light sky |
| Violet Ember | 5 stops: dark purple → violet → pink |
| Teal Afterglow | 5 stops: dark teal → cyan → mint |
| Solar Ember | 5 stops: dark red → orange → warm yellow |
| Citrus Pulse | 5 stops: dark brown → amber → golden |
| Rose Heat | 5 stops: dark crimson → rose → pink |

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `50:4208`
- **React:** `<ColorRampEditor nodeId={id} data={params} />`
- **File:** `src/components/ColorRampEditor.tsx`

## Parity: ✅ Match

All elements match: gradient bar, draggable stops, color picker, +/- buttons, and preset dropdown. The Figma component uses the same DS tokens as the code.
