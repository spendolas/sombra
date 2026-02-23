# Full Window Overlay

## Overview

| Field | Value |
|---|---|
| Figma ID | `86:286` |
| Figma Page | Organisms |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/FullWindowOverlay.tsx` |
| React Component | `<FullWindowOverlay />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=86:286) |

## Figma Screenshot

1440×900 pure black rectangle covering the entire viewport. Preview Toolbar (fullwindow mode active) at top-right with 8px offset.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | 1440px (viewport) | `fixed inset-0` (full viewport) | ✅ |
| Height | 900px (viewport) | `fixed inset-0` (full viewport) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#000000` | (literal black) | `bg-black` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Toolbar position | top-right, 8px inset | `absolute top-2 right-2` (8px) | ✅ |
| Toolbar z-index | above content | `z-10` | ✅ |
| Panel position | fixed, full viewport | `fixed inset-0 z-50` | ✅ |

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Corner radius | 0 (full bleed) | — (none) | ✅ |
| Border | none | — | ✅ |

## Children

- Render target `<div>` (full width/height, WebGL canvas destination)
- Preview Toolbar molecule (fullwindow mode variant, absolute positioned)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `86:286`
- **React:** `<FullWindowOverlay targetRef={previewRef} />`
- **File:** `src/components/FullWindowOverlay.tsx`

## Parity: ✅ Match

Pure black fullscreen overlay with toolbar at top-right. Simplest organism — no border, no radius, no shadow. Just black canvas + toolbar.
