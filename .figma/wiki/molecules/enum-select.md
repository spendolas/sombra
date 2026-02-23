# Enum Select

## Overview

| Field | Value |
|---|---|
| Figma ID | `17:235` |
| Figma Page | Molecules |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/NodeParameters.tsx` |
| React Component | `EnumSelect` (not exported, used internally) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=17:235) |

## Figma Screenshot

"Noise Type" label above a dropdown trigger showing "simplex" with a chevron indicator.

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | FILL | — | `w-full` | ✅ |
| Trigger height | 28px | size/input-md (`43:3521`) | `h-7` (28px) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Label text | `#88889a` | fg/subtle (`17:14`) | `text-fg-subtle` (via `text-[10px] text-fg-subtle`) | ✅ |
| Trigger bg | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Trigger text | `#e8e8f0` | fg/default (`17:12`) | `text-fg` | ✅ |
| Trigger border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |
| Dropdown bg | `#2d2d44` | surface/elevated (`17:11`) | `bg-surface-elevated` | ✅ |
| Dropdown border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Label ↔ trigger gap | 6px | spacing/sm (`17:916`) | `space-y-1.5` (6px) | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Label size | 10px | `text-[10px]` | ✅ |
| Trigger text | 12px | `text-xs` | ✅ |
| Item text | 12px | `text-xs` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Trigger radius | 4px | radius/sm (`17:922`) | shadcn Select default | ⚠️ |

## Children

- Label text
- shadcn Select (trigger + content)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `17:235`
- **React:** `<EnumSelect param={param} value={value} onChange={fn} />`
- **File:** `src/components/NodeParameters.tsx`

## Parity: ✅ Match

Label, trigger, dropdown colors, and sizing all match. Minor radius difference (Figma 4px vs shadcn ~6px) — same as the global radius/sm note in tokens/radius.md.
