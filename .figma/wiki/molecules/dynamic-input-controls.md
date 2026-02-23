# Dynamic Input Controls

## Overview

| Field | Value |
|---|---|
| Figma ID | (inline in node templates) |
| Figma Page | Molecules (embedded in templates) |
| Type | Instance group |
| Variants | none |
| React File | `src/components/ShaderNode.tsx` |
| React Component | (inline `<div>` in ShaderNode) |
| Figma URL | — (part of Arithmetic/Trig node templates) |

## Description

The +/- button row that appears on nodes with dynamic inputs (Arithmetic, Trig). Contains two PlusMinus Button atoms flanking a count display.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL | block-level div | ✅ |
| Height | auto (hug) | auto | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Count text | `#5a5a6e` | fg/muted (`17:15`) | `text-fg-muted` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Direction | horizontal (row) | `flex items-center justify-center` | ✅ |
| Gap | 8px (spacing/md) | `gap-2` | ✅ |
| Padding Y | 4px | `py-1` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Count size | 10px | `text-[10px]` | ✅ |

## Children

- 1x PlusMinus Button atom (minus, enabled/disabled)
- 1x Count label text
- 1x PlusMinus Button atom (plus, enabled/disabled)

## Code Connect

- **Status:** ❌ Inline — not a standalone Figma component
- **Code location:** `src/components/ShaderNode.tsx` lines 168-198

## Parity: ✅ Match

The dynamic input controls row matches Figma. Button sizing (20×20), gap (8px), count text styling, and enabled/disabled states are all aligned. The count ranges from 2-8 in the app.
