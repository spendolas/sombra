# Random Display

## Overview

| Field | Value |
|---|---|
| Figma ID | `111:954` |
| Figma Page | Components (Molecules) |
| Type | COMPONENT |
| Variants | — |
| React File | `src/components/RandomDisplay.tsx` |
| React Component | `RandomDisplay` |

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | 160px (FIXED) | parent width | ✅ |
| Height | HUG (~20px) | auto | ✅ |

### Colors

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Value text | #e8e8f0 | fg/default (VariableID:106:7) | `text-fg` | ✅ |
| Button bg | #1a1a2e | surface/alt (VariableID:106:4) | `bg-surface-alt` | ✅ |
| Button border | #3a3a52 | edge/default (VariableID:106:11) | `border-edge` | ✅ |
| Button icon | #b8b8c8 | fg/dim (VariableID:106:8) | `text-fg-dim` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Padding horizontal | 4px | `px-1` (4px) | ✅ |
| Gap | 8px | `gap-2` (8px) | ✅ |
| Layout direction | HORIZONTAL | `flex items-center` | ✅ |
| Justify | SPACE_BETWEEN | `justify-between` | ✅ |
| Button size | 20x20 | `w-5 h-5` (20px) | ✅ |
| Button radius | 4px | `rounded` (4px) | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Value font | Inter Regular 12px | `font-mono text-xs` | ✅ |
| Value features | tabular-nums | `tabular-nums` | ✅ |

## Children

1. **Value** — "0.4231" text, mono, tabular-nums, flex-1
2. **Randomise** — 20x20 button with shuffle icon (⇄), rounded, border edge

## Behavior

- Displays computed random value matching GLSL hash rounding
- Randomise button regenerates seed via `Math.random()`
- Auto-initializes seed on first render if undefined

## Code Connect

- **Figma Node:** `111:954`
- **React Component:** `RandomDisplay`
- **File:** `src/components/RandomDisplay.tsx`

## Parity: ✅ Match
