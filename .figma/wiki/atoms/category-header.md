# Category Header

## Overview

| Field | Value |
|---|---|
| Figma ID | `37:96` |
| Figma Page | Atoms |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/NodePalette.tsx` |
| React Component | (inline `<h3>`) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=37:96) |

## Figma Screenshot

"CATEGORY" text in small uppercase letters, `fg/subtle` color, semibold weight.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Width | FILL | block-level `<h3>` | ✅ |
| Height | auto (hug) | auto | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | CSS Variable | Tailwind | Match |
|---|---|---|---|---|---|
| Text | `#88889a` | fg/subtle (`17:14`) | `--fg-subtle` | `text-fg-subtle` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Font size | 10px | `text-[10px]` | ✅ |
| Font weight | 600 (semibold) | `font-semibold` | ✅ |
| Text transform | UPPERCASE | `uppercase` | ✅ |
| Letter spacing | wider | `tracking-wider` | ✅ |

### Spacing

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Margin bottom | 8px | spacing/md (`17:917`) | `mb-2` (8px) | ✅ |

## Children

None (atom — text only)

## Code Connect

- **Status:** ❌ Inline component (no named export)
- **Figma Node:** `37:96`
- **Code location:** `src/components/NodePalette.tsx` line 20
- **JSX:**
```tsx
<h3 className="text-[10px] font-semibold uppercase tracking-wider mb-2 text-fg-subtle">
  {category}
</h3>
```

## Parity: ✅ Match

Font size, weight, transform, spacing, and color all match exactly.
