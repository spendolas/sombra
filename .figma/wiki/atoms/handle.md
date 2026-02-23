# Handle

## Overview

| Field | Value |
|---|---|
| Figma ID | `17:161` |
| Figma Page | Atoms |
| Type | COMPONENT_SET |
| Variants | 16: portType (8) x connected (true/false) |
| React File | `src/components/base-handle.tsx` |
| React Component | `<BaseHandle />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=17:161) |

## Figma Screenshot

Shows 16 variants in 2 rows:
- **Top row** (connected=true): 8 filled circles in port type colors (float/vec2/vec3/vec4/color/sampler2D/fnref/default)
- **Bottom row** (connected=false): 8 outlined circles with `surface/elevated` fill and port-type-colored borders

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | 12px | size/handle (`43:3518`) | `!w-3` (12px) | ✅ |
| Height | 12px | size/handle (`43:3518`) | `!h-3` (12px) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | CSS Variable | Code | Match |
|---|---|---|---|---|---|
| Border (per type) | varies | Port Types collection (`17:21`) | — | `handleColor` prop from `getPortColor()` | ✅ |
| Fill (connected=false) | `#2d2d44` | surface/elevated (`17:11`) | `--surface-elevated` | `var(--surface-elevated)` | ✅ |
| Fill (connected=true) | (port color) | Port Types collection (`17:21`) | — | `handleColor` prop | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 9999px | radius/full (`17:925`) | `rounded-full` | ✅ |
| Border width | 2px | (literal) | `border-2` | ✅ |

### Effects

| Property | Figma | Code | Match |
|---|---|---|---|
| Transition | — | `transition` (Tailwind class) | ✅ (code-only enhancement) |

## Children

None (atom — indivisible)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `17:161`
- **React:** `<BaseHandle type={type} position={position} handleColor={getPortColor(portType)} connected={isConnected} />`
- **File:** `src/components/base-handle.tsx`
- **Props:** `handleColor?: string`, `connected?: boolean`, `type`, `position`, `id`

## Parity: ✅ Match

All 16 variants match. Disconnected handles show `surface/elevated` fill with port-type border. Connected handles show solid port-type fill with port-type border. Both use inline `style` for dynamic port colors (justified exception to no-inline-style rule).
