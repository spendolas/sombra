# Port Type Badge

## Overview

| Field | Value |
|---|---|
| Figma ID | `37:131` |
| Figma Page | Atoms |
| Type | COMPONENT_SET |
| Variants | 8: portType (float/vec2/vec3/vec4/color/sampler2D/fnref/default) |
| React File | `src/components/PropertiesPanel.tsx` |
| React Component | (inline `<span>`) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=37:131) |

## Figma Screenshot

8 colored text labels in a row: "float", "vec2", "vec3", "vec4", "color", "sampler2D", "fnref", "default" — each colored with its port type color from the Port Types variable collection.

## Properties

### Colors (per variant)

| Variant | Figma Hex | Figma Variable | Code (`PORT_COLORS`) | Match |
|---|---|---|---|---|
| float | `#d4d4d8` | Port Types/float (`17:22`) | `'#d4d4d8'` | ✅ |
| vec2 | `#34d399` | Port Types/vec2 (`17:23`) | `'#34d399'` | ✅ |
| vec3 | `#60a5fa` | Port Types/vec3 (`17:24`) | `'#60a5fa'` | ✅ |
| vec4 | `#a78bfa` | Port Types/vec4 (`17:25`) | `'#a78bfa'` | ✅ |
| color | `#fbbf24` | Port Types/color (`17:26`) | `'#fbbf24'` | ✅ |
| sampler2D | `#f472b6` | Port Types/sampler2D (`17:27`) | `'#f472b6'` | ✅ |
| fnref | `#22d3ee` | Port Types/fnref (`17:28`) | `'#22d3ee'` | ✅ |
| default | `#6b7280` | Port Types/default (`17:29`) | `'#6b7280'` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Font family | SF Mono / monospace | `font-mono` | ✅ |
| Font size | 11px | `text-[11px]` (in context) | ✅ |

## Usage in App

In `PropertiesPanel.tsx`, port type badges appear in the Inputs and Outputs sections:

```tsx
<span className="font-mono text-fg-muted">
  {input.type}
</span>
```

Note: The properties panel uses `text-fg-muted` for all port types rather than individual port colors. The Figma component uses per-type colors from the Port Types collection. This is a deliberate simplification in the properties panel context.

## Children

None (atom — text only)

## Code Connect

- **Status:** ❌ Inline component (no named export)
- **Figma Node:** `37:131`
- **Code location:** `src/components/PropertiesPanel.tsx` lines 145-148, 166-169

## Parity: ⚠️ Minor difference

The Figma component colors each badge with its port type color. The app's PropertiesPanel uses a uniform `text-fg-muted` for all type labels. The type text content matches perfectly; only the color treatment differs (individual colors in Figma vs uniform muted in app).
