# Color Input

## Overview

| Field | Value |
|---|---|
| Figma ID | `17:240` |
| Figma Page | Molecules |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/NodeParameters.tsx` |
| React Component | `ColorInput` (not exported, used internally) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=17:240) |

## Figma Screenshot

"Color" label above a color swatch rectangle showing a blue color (`#6699ff` placeholder).

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | FILL | — | `w-full` | ✅ |
| Swatch height | 24px | size/swatch (`43:3522`) | `h-6` (24px) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Label text | `#88889a` | fg/subtle (`17:14`) | `text-fg-subtle` | ✅ |
| Swatch bg | dynamic | — | HTML color input value | ✅ |
| Swatch border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |
| Swatch bg (wrapper) | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Label ↔ swatch gap | 6px | spacing/sm (`17:916`) | `space-y-1.5` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Label size | 10px | `text-[10px]` | ✅ |

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Swatch radius | 4px (radius/sm) | `rounded` | ✅ |
| Border width | 1px | `border` | ✅ |

## Children

- Label text
- HTML `<input type="color">` swatch

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `17:240`
- **React:** `<ColorInput param={param} value={value} onChange={fn} />`
- **File:** `src/components/NodeParameters.tsx`

## Parity: ✅ Match

The Figma swatch uses `#6699ff` as placeholder content (unbound — justified exception). The app renders an HTML color picker input with the actual node parameter color. Label, border, and spacing match.
