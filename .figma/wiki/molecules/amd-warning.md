# AMD Warning

## Overview

| Field | Value |
|---|---|
| Figma ID | `884:355` |
| Figma Page | Components (Molecules, Row 6) |
| Type | COMPONENT_SET |
| Variants | 2 (State=Collapsed, State=Expanded) |
| React File | `src/components/AmdSeeThroughWarning.tsx` |
| React Component | `AmdSeeThroughWarning` |
| DS Key | `amdWarning` |

Shown beside the background-mode switcher while see-through is active on an AMD
GPU, where a transparent canvas composited over the page flickers under
macOS/Chrome. The flicker is informed and accepted; this flags it.

Auto-expands once per session on the first see-through activation, collapses after
a timeout, and re-expands on hover. Hover is right here because it is ambient
status — contrast the [Compile Error Banner](compile-error-banner.md), which is
click-to-expand because an error is read and copied.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Collapsed | 32×32 (HUG) | icon + `p-md` | ✅ |
| Expanded | 165×32 (HUG) | label animates to `max-w-[12rem]` | ✅ |

### Colors

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Surface fill | #1a1a2e @ 60% | surface/alt (`VariableID:106:4`) | `bg-surface-alt/60` | ✅ |
| Tint fill | #fbbf24 @ 10% | color/warning (`VariableID:881:311`) | `bg-warning/10` | ✅ |
| Icon | #fbbf24 | color/warning (`VariableID:881:311`) | `text-warning` | ✅ |
| Label | #fbbf24 | color/warning (`VariableID:881:311`) | `text-warning` | ✅ |

Figma stacks surface and tint as two fills on one node; a DS part carries one
fill, so the tint is a layered `<span>` in code.

> Note: the pill's own fills are **not** variable-bound in Figma (only its strokes
> and text are). The Compile Error Banner binds all of them. Worth reconciling in a
> future pass.

### Effects

| Property | Figma | Code | Match |
|---|---|---|---|
| Background blur | BACKGROUND_BLUR 16 | `backdrop-blur-[16px]` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Padding | 8px (spacing/md) | `p-md` | ✅ |
| Gap | 8px (spacing/md) | animated `ml-md` | `auditIgnore` |
| Radius | 8px (radius/md) | `rounded-md` | ✅ |
| Direction | HORIZONTAL | `flex-row` | ✅ |
| Align | CENTER | `items-center` | ✅ |

**Why `gap` is ignored:** Figma collapses the pill by hiding the label, and
auto-layout then drops the gap (32×32). CSS cannot hide a child and transition it
at the same time, so the code keeps the label rendered and animates its margin
instead; a static flex `gap` would leave 8px in the collapsed state. Remove the
ignore only if the collapse stops being animated.

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Label | label/param | `text-param` | ✅ |

## History

Migrated to the DS on 2026-09-13, once the generator gained `fillOpacity` and
`backdropBlur`. Two Figma corrections were made during that migration, both
resolved in favour of the shipped code: the label was bound to `mono/id` rather
than `label/param`, and counter-axis alignment was `MIN` rather than `CENTER`.

## Sandbox

`npm run sandbox` → Chrome → AMD Warning. Renders the pill over a moving backdrop
and over a flat surface, the latter being the standing argument for keeping in-node
chrome on a solid fill rather than paying for a blur.
