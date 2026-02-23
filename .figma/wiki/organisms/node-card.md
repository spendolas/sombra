# Node Card

## Overview

| Field | Value |
|---|---|
| Figma ID | `88:2435` |
| Figma Page | Organisms |
| Type | COMPONENT_SET |
| Variants | 2: selected (true / false) |
| React File | `src/components/ShaderNode.tsx` + `src/components/base-node.tsx` |
| React Component | `<ShaderNode />` (wraps `<BaseNode>`) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=88:2435) |

## Figma Screenshot

Two variants: unselected card (normal border) and selected card (indigo border + shadow). Each has: "Node Name" header (surface/raised bg) and "(handles & params)" content area (surface/elevated bg).

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Min width | 160px | size/node-min-w (`43:3523`) | `min-w-[160px]` | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Body bg | `#2d2d44` | surface/elevated (`17:11`) | `bg-surface-elevated` | ✅ |
| Header bg | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Header text | `#e8e8f0` | fg/default (`17:12`) | `text-fg` (`text-sm text-fg`) | ✅ |
| Border (unselected) | `#3a3a52` | edge/default (`17:16`) | `border` (via base-node) | ✅ |
| Border (selected) | `#6366f1` | indigo/default (`17:18`) | `.selected` → `border-color: var(--indigo)` | ✅ |
| Selection glow | `#6366f1` | indigo/default (`17:18`) | `box-shadow: 0 0 0 2px var(--indigo)` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Header padding-x | 12px | spacing/lg (`17:918`) | `px-3` | ✅ |
| Header padding-y | 8px | spacing/md (`17:917`) | `py-2` | ✅ |
| Content padding | 12px | spacing/lg (`17:918`) | `p-3` | ✅ |
| Content gap | 8px | spacing/md (`17:917`) | `gap-y-2` | ✅ |
| Header-content gap | -4px | — | `-mb-1` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Title size | 14px | `text-sm` (14px) | ✅ |
| Title weight | 600 (semibold) | `font-semibold` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Card radius | 8px | radius/md (`17:923`) | `rounded-md` | ✅ |
| Header top radius | 8px | radius/md (`17:923`) | `rounded-t-md` | ✅ |
| Border width | 1px | (literal) | `border` | ✅ |
| Header bottom border | 1px edge/subtle | edge/subtle (`17:17`) | `border-b border-edge-subtle` | ✅ |

### Effects

| Property | Figma | Code | Match |
|---|---|---|---|
| Selected shadow | drop shadow | `shadow-lg` (via `.selected`) | ✅ |
| Hover ring | — | `hover:ring-1` | ✅ (code-only) |

## Children

- BaseNodeHeader (title text)
- BaseNodeContent containing:
  - LabeledHandle molecules (outputs, then inputs)
  - Dynamic Input Controls (if applicable)
  - Connectable Param Rows (if applicable)
  - Separator (before regular params)
  - NodeParameters (regular params)
  - Custom component (e.g., ColorRampEditor)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `88:2435`
- **React:** `<ShaderNode id={id} data={data} />`
- **File:** `src/components/ShaderNode.tsx`

## Parity: ✅ Match

Both variants match. Unselected: standard border + surface colors. Selected: indigo border + indigo glow shadow. All spacing, typography, and color tokens are aligned.
