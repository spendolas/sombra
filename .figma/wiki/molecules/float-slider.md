# Float Slider (SombraSlider)

## Overview

| Field | Value |
|---|---|
| Figma ID | `106:282` |
| Figma Page | Components (Molecules) |
| Type | COMPONENT |
| Variants | — (single state, default) |
| React File | `src/components/ui/sombra-slider.tsx` |
| React Component | `<SombraSlider />` |
| Wrapper | `<FloatSlider />` in `src/components/NodeParameters.tsx` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=106:282) |

## Structure

```
COMPONENT "Float Slider" [VERTICAL 140×30, gap=2xs]
  FRAME "Label Row" [HORIZONTAL 140×18, cursor=ew-resize]
    TEXT "Parameter" (label/param, 10px, fg-subtle)
    TEXT "0.42" (label/param, 10px, fg, tabular-nums, cursor=text)
  RECTANGLE "Track" [140×6, r=full, surface-raised fill]
    RECTANGLE "Fill" [58×6, r=full, indigo fill, left-aligned]
```

No visible thumb — the fill edge IS the thumb.

## Features

- **Blender-style label scrub** — drag anywhere on label row to scrub value (ew-resize cursor)
- **Shift+drag fine control** — 10x smaller step when Shift held during drag
- **Double-click to reset** — resets to `param.default`
- **Click value to edit** — inline text input for precise entry
- **Dual-thumb range mode** — `[number, number]` value renders two fill edges with highlighted range between
- **Track shows param range** — scrub/text entry allow values beyond visible range
- **nodrag nowheel** — prevents React Flow canvas interference

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | FILL | — | block-level div | ✅ |
| Slider track height | 6px | slider/track (`106:45`) | `h-slider-track` (6px) | ✅ |
| Label+value row gap | 2xs (2px) | 2xs/2 (`106:26`) | `gap-2xs` | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Label text | `#88889a` | fg/subtle (`106:9`) | `text-fg-subtle` | ✅ |
| Value text | `#e8e8f0` | fg (`106:7`) | `text-fg` | ✅ |
| Track bg | `#252538` | surface/raised (`106:5`) | `bg-surface-raised` | ✅ |
| Fill | `#6366f1` | indigo/default (`106:13`) | `bg-indigo` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Label size | 10px | `text-param` (10px) | ✅ |
| Value size | 10px | `text-param` (10px) | ✅ |
| Value alignment | RIGHT | `text-right` | ✅ |
| Value font feature | tabular-nums | `tabular-nums` | ✅ |

## Dual-Thumb Range Mode

When `value` is `[number, number]`:
- Two labels displayed: "Min 0.20" on left, "Max 0.80" on right
- Track fill between the two positions
- Each thumb independently draggable and scrubbable
- Used by Smoothstep node (Min/Max connectable params)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `106:282`
- **React:** `<SombraSlider label={label} value={value} onChange={fn} min={min} max={max} step={step} defaultValue={def} />`
- **File:** `src/components/ui/sombra-slider.tsx`

## Parity: ✅ Match

Slider uses SombraSlider: track `bg-surface-raised` (#252538), fill `bg-indigo` (#6366f1), no visible thumb, label scrub with ew-resize cursor.
