# PlusMinus Button

## Overview

| Field | Value |
|---|---|
| Figma ID | `17:258` |
| Figma Page | Atoms |
| Type | COMPONENT_SET |
| Variants | 4: type (plus/minus) x state (enabled/disabled) |
| React File | `src/components/ShaderNode.tsx` |
| React Component | (inline `<button>`) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=17:258) |

## Figma Screenshot

4 rounded square buttons in a row:
- **+ enabled:** `surface/alt` bg, `fg/default` text
- **+ disabled:** `surface/raised` bg, `fg/muted` text
- **- enabled:** `surface/alt` bg, `fg/default` text
- **- disabled:** `surface/raised` bg, `fg/muted` text

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Width | 20px | size/button-sm (`43:3519`) | `w-5` (20px) | ✅ |
| Height | 20px | size/button-sm (`43:3519`) | `h-5` (20px) | ✅ |

### Colors (Enabled)

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#1a1a2e` | surface/alt (`17:9`) | `bg-surface-alt` | ✅ |
| Text | `#e8e8f0` | fg/default (`17:12`) | `text-fg` | ✅ |
| Border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |

### Colors (Disabled)

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Background | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Text | `#5a5a6e` | fg/muted (`17:15`) | `text-fg-muted` | ✅ |
| Border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Layout | center-center flex | `flex items-center justify-center` | ✅ |
| Gap (between buttons) | 8px (spacing/md) | `gap-2` (8px) | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Symbol size | 12px | `text-xs` (12px) | ✅ |
| Line height | none | `leading-none` | ✅ |

### Border & Radius

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Corner radius | 4px | radius/sm (`17:922`) | `rounded` (4px) | ✅ |
| Border width | 1px | (literal) | `border border-edge` | ✅ |

## Children

None (atom — text symbol only: "+" or "-")

## Code Connect

- **Status:** ❌ Inline component (no named export)
- **Figma Node:** `17:258`
- **Code location:** `src/components/ShaderNode.tsx` lines 170-197
- **JSX:**
```tsx
<button
  onClick={handleRemoveInput}
  disabled={inputCount <= 2}
  className={cn(
    "w-5 h-5 flex items-center justify-center rounded text-xs leading-none border border-edge",
    inputCount <= 2
      ? "bg-surface-raised text-fg-muted cursor-default"
      : "bg-surface-alt text-fg cursor-pointer"
  )}
>-</button>
```

## Parity: ✅ Match

All 4 variants match. Enabled/disabled states use correct background and text colors. Size, radius, and border are exact.
