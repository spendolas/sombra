# Float Slider

## Overview

| Field | Value |
|---|---|
| Figma ID | `106:282` |
| Figma Page | Components (Molecules) |
| Type | COMPONENT |
| Variants | — (single state, default) |
| React File | `src/components/NodeParameters.tsx` |
| React Component | `<FloatSlider />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=106:282) |

## Structure

```
COMPONENT "Float Slider" [VERTICAL 140×46, gap=6]
  FRAME "Label Row" [HORIZONTAL 140×24]
    TEXT "Parameter" (label/param, 10px)
    FRAME "Value Box" [64×24, r=4, surface-raised fill]
      TEXT "0.50" (mono/value, 12px)
  FRAME "Slider" [NONE 140×16, no fill]
    RECTANGLE "Track" [140×6, r=full, surface/raised fill, y=5]
    RECTANGLE "Range" [42×6, r=full, indigo/default fill, x=0, y=5]
    ELLIPSE "Thumb" [16×16, white fill, x=34, y=0]
```

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | FILL | — | block-level div | ✅ |
| Slider wrapper height | 16px | slider/thumb (`106:46`) | — (Radix handles) | ✅ |
| Slider track height | 6px | slider/track (`106:45`) | `h-1.5` (6px) | ✅ |
| Thumb size | 16px | slider/thumb (`106:46`) | `size-4` (16px) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Label text | `#88889a` | fg/subtle (`106:9`) | `text-fg-subtle` | ✅ |
| Value text | `#5a5a6e` | fg/muted (`106:10`) | `text-fg-muted` (disabled) | ✅ |
| Track bg | `#252538` | surface/raised (`106:5`) | `bg-muted` on Radix Track | ✅ |
| Range fill | `#6366f1` | indigo/default (`106:13`) | `bg-primary` on Radix Range | ✅ |
| Thumb | `#ffffff` | white (`106:16`) | `bg-white` on Radix Thumb | ✅ |
| Input bg | `#252538` | surface/raised (`106:5`) | shadcn Input | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Label ↔ value gap | 4px | xs/4 (`106:27`) | flex + gap between items | ✅ |
| Stack gap | 6px | sm/6 (`106:28`) | `space-y-1.5` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Label size | 10px | `text-[10px]` | ✅ |
| Value size | 10px | `text-[10px]` | ✅ |
| Value alignment | RIGHT | `text-right` on Input | ✅ |
| Value font | tabular-nums | `tabular-nums` | ✅ |

## Children

- **Label Row** — parameter name (`label/param`) + value input (`mono/value`, right-aligned)
- **Slider** — NONE-layout wrapper containing:
  - **Track** — full-width rectangle, `surface/raised`, `r=full`
  - **Range** — left-aligned rectangle, `indigo/default`, `r=full` (represents filled portion)
  - **Thumb** — 16px ellipse, `white`, positioned at range edge

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `106:282`
- **React:** `<FloatSlider param={param} value={value} onChange={fn} disabled={isConnected} />`
- **File:** `src/components/NodeParameters.tsx`

## Parity: ✅ Match

Slider colors match exactly between Figma and app: track `surface/raised` (#252538), range `indigo/default` (#6366f1), thumb `white` (#ffffff). Code uses Sombra tokens directly (`bg-surface-raised`, `bg-indigo`, `border-indigo`) instead of generic shadcn defaults.
