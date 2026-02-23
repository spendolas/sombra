# Connectable Param Row

## Overview

| Field | Value |
|---|---|
| Figma ID | `37:200` |
| Figma Page | Molecules |
| Type | COMPONENT_SET |
| Variants | 2: state (unwired / wired) |
| React File | `src/components/ShaderNode.tsx` |
| React Component | (inline `<div>` in ShaderNode) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=37:200) |

## Figma Screenshot

Two variants side by side:
- **Unwired:** Handle (left, disconnected) + FloatSlider (label "Scale", value "1.00", interactive track)
- **Wired:** Handle (left, connected/filled) + FloatSlider (dimmed, value "1.00", non-interactive)

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL | `flex-1` | ✅ |
| Height | auto (hug) | auto | ✅ |

### Colors

| Property (unwired) | Figma | Code | Match |
|---|---|---|---|
| Handle | disconnected (outlined) | `connected={false}` | ✅ |
| Slider | full opacity | no `disabled` | ✅ |

| Property (wired) | Figma | Code | Match |
|---|---|---|---|
| Handle | connected (filled) | `connected={true}` | ✅ |
| Slider | dimmed (60% opacity) | `opacity-60 pointer-events-none` | ✅ |

### Spacing & Layout

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Handle position | absolute, left edge | — | `<BaseHandle>` (absolute, via React Flow) | ✅ |
| Content padding-left | 16px | spacing/xl (`17:919`) | `pl-4` (16px) | ✅ |
| Content padding-right | 4px | spacing/xs (`17:915`) | `pr-1` (4px) | ✅ |

## Children

- 1x Handle atom (absolute-positioned at left edge)
- 1x FloatSlider molecule (or source label when connected to dynamic source)

## Code Connect

- **Status:** ❌ Inline component (no named export)
- **Figma Node:** `37:200`
- **Code location:** `src/components/ShaderNode.tsx` lines 224-255

## Parity: ✅ Match

Both states match. Handle absolute positioning, slider dimming when connected, and padding values are all aligned between Figma and code.
