# Floating Preview

## Overview

| Field | Value |
|---|---|
| Figma ID | `86:261` |
| Figma Page | Organisms |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/FloatingPreview.tsx` |
| React Component | `<FloatingPreview />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=86:261) |

## Figma Screenshot

400×300 black rectangle with rounded corners, subtle border, drop shadow, and Preview Toolbar (floating mode active) positioned at top-right with 8px offset.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Default width | 400px | `floatingSize.width` (default 400) | ✅ |
| Default height | 300px | `floatingSize.height` (default 300) | ✅ |
| Min width | 200px | `MIN_W = 200` | ✅ |
| Min height | 150px | `MIN_H = 150` | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | CSS/Tailwind | Match |
|---|---|---|---|---|
| Background | `#000000` | (literal black) | `bg-black` | ✅ |
| Border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Toolbar position | top-right, 8px inset | `absolute top-2 right-2` (8px) | ✅ |
| Toolbar z-index | above content | `z-10` | ✅ |
| Panel position | fixed | `fixed z-40` | ✅ |
| Margin from edges | 16px | `MARGIN = 16` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 8px | radius/md (`17:923`) | `rounded-lg` (10px) | ⚠️ |
| Border width | 1px | (literal) | `border` | ✅ |

### Effects

| Property | Figma | Code | Match |
|---|---|---|---|
| Drop shadow | drop shadow | `shadow-2xl` | ✅ |
| Overflow | hidden | `overflow-hidden` | ✅ |

### Interactivity (code-only)

| Feature | Implementation |
|---|---|
| Drag | Top 32px invisible surface, `cursor-grab` / `cursor-grabbing` |
| Resize | 8 edge/corner zones (6px wide), direction-specific cursors |
| Clamping | Stays within viewport bounds |
| Position persistence | Stored in `settingsStore` |

## Children

- Preview Toolbar molecule (floating mode variant, absolute positioned)
- Drag surface (invisible, 32px tall)
- Render target `<div>` (WebGL canvas destination)
- 8 resize handles (4 edges + 4 corners)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `86:261`
- **React:** `<FloatingPreview targetRef={previewRef} />`
- **File:** `src/components/FloatingPreview.tsx`

## Parity: ✅ Match

Dimensions, colors, shadow, and toolbar positioning all match. Minor radius difference (Figma 8px vs code 10px) — negligible. The drag/resize behavior is code-only (not represented in Figma static design).
