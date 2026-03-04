# Node Footer

## Overview

| Field | Value |
|---|---|
| Figma ID | `111:491` |
| Figma Page | Components (Atoms) |
| Type | COMPONENT |
| Variants | — |
| React File | `src/components/base-node.tsx` |
| React Component | `BaseNodeFooter` |

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL | flex (via parent auto-layout) | ✅ |
| Height | HUG (~40px) | auto | ✅ |

### Colors

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Background | transparent | — | none (inherits) | ✅ |
| Border top | #3a3a52 | edge/default (VariableID:106:11) | `border-t` | ✅ |
| Placeholder text | #88889a | fg/subtle (VariableID:106:9) | — | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Padding top | 8px | `pt-2` (8px) | ✅ |
| Padding bottom | 12px | `pb-3` (12px) | ✅ |
| Padding horizontal | 12px | `px-3` (12px) | ✅ |
| Gap | 8px | `gap-y-2` (8px) | ✅ |
| Layout direction | VERTICAL | `flex flex-col` | ✅ |
| Align items | CENTER | `items-center` | ✅ |

## Children

- Placeholder content frame/text (replaced by actual content in use, e.g., Gradient Editor)

## Usage

Used inside Node Card for nodes that have custom footer content (e.g., Color Ramp node with Gradient Editor).

## Code Connect

- **Figma Node:** `111:491`
- **React Component:** `BaseNodeFooter`
- **File:** `src/components/base-node.tsx`

## Parity: ✅ Match
