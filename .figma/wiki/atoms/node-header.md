# Node Header

## Overview

| Field | Value |
|---|---|
| Figma ID | `111:488` |
| Figma Page | Components (Atoms) |
| Type | COMPONENT |
| Variants | — |
| React File | `src/components/base-node.tsx` |
| React Component | `BaseNodeHeader` + `BaseNodeHeaderTitle` |

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL | flex-1 (via parent auto-layout) | ✅ |
| Height | HUG (~32px) | auto (py-2 = 8px top/bottom + text) | ✅ |

### Colors

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Background | #252538 | surface/raised (VariableID:106:5) | `bg-surface-raised` | ✅ |
| Title text | #e8e8f0 | fg/default (VariableID:106:7) | `text-fg` | ✅ |
| Border bottom | #2a2a3e | edge/subtle (VariableID:106:12) | `border-b border-edge-subtle` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Padding vertical | 8px | `py-2` (8px) | ✅ |
| Padding horizontal | 12px | `px-3` (12px) | ✅ |
| Gap | 8px | `gap-2` (8px) | ✅ |
| Layout direction | HORIZONTAL | `flex flex-row` | ✅ |
| Align items | CENTER | `items-center` | ✅ |
| Justify | SPACE_BETWEEN | `justify-between` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Font | Inter Semi Bold | `font-semibold` | ✅ |
| Size | 14px | `text-sm` (14px) | ✅ |

### Corner Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Top-left | 8px | `rounded-t-md` | ✅ |
| Top-right | 8px | `rounded-t-md` | ✅ |
| Bottom-left | 0 | — | ✅ |
| Bottom-right | 0 | — | ✅ |

## Children

- 1x Text "Node Label" — title text, Inter Semi Bold 14px, fill fg/default, flex-1

## Code Connect

- **Figma Node:** `111:488`
- **React Component:** `BaseNodeHeader` + `BaseNodeHeaderTitle`
- **File:** `src/components/base-node.tsx`

## Parity: ✅ Match

Layout, padding, colors, typography, and border all match the code spec exactly. Height auto-sizes to ~32px from 8px padding + 14px text + 8px padding.
