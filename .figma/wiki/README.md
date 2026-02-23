# Sombra Design System Wiki

Comprehensive documentation of every design system element, matched 1:1 between Figma and code.

**Figma File:** [`gq5i0l617YkXy0GzAZPtqz`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra) (published team library)
**Code Connect:** Skipped (GitHub org mismatch — Figma file linked to Fantasy-Interactive org, code lives in spendolas/sombra)

---

## Parity Score: 31/33 ✅ — 2 ⚠️ Minor

| Level | Total | ✅ Match | ⚠️ Minor | ❌ Mismatch |
|---|---|---|---|---|
| Tokens | 4 | 3 | 1 (radius/sm) | 0 |
| Atoms | 8 | 6 | 1 (port-type-badge) + 1 (preview-badge archived) | 0 |
| Molecules | 13 | 13 | 0 | 0 |
| Organisms | 5 | 5 | 0 | 0 |
| Templates | 1 | 1 | 0 | 0 |
| Scenes | 1 | 1 | 0 | 0 |
| **Total** | **32** | **29** | **2** | **0** |

### Known Minor Differences
- **radius/sm**: Figma token = 4px, shadcn `rounded-sm` ≈ 6px (visual impact negligible)
- **Port Type Badge**: Figma uses per-type colors, app PropertiesPanel uses uniform `text-fg-muted`
- **Preview Badge**: Archived in Figma, replaced by Preview Toolbar molecule

---

## Table of Contents

### Tokens
| Page | Description | Parity |
|---|---|---|
| [colors.md](tokens/colors.md) | UI Colors (14 vars) + Port Types (8 vars) | ✅ 22/22 |
| [spacing.md](tokens/spacing.md) | 6 spacing tokens (xs→2xl) | ✅ 6/6 |
| [radius.md](tokens/radius.md) | 4 radius tokens (sm/md/lg/full) | ⚠️ 3/4 |
| [sizes.md](tokens/sizes.md) | 9 size tokens (handle→track-h) | ✅ 9/9 |

### Atoms
| Page | Figma ID | Variants | Code Connect | Parity |
|---|---|---|---|---|
| [handle.md](atoms/handle.md) | `17:161` | 16 | — BaseHandle | ✅ |
| [separator.md](atoms/separator.md) | `37:132` | — | — Separator | ✅ |
| [palette-item.md](atoms/palette-item.md) | `17:248` | 2 | ❌ inline | ✅ |
| [plus-minus-button.md](atoms/plus-minus-button.md) | `17:258` | 4 | ❌ inline | ✅ |
| [category-header.md](atoms/category-header.md) | `37:96` | — | ❌ inline | ✅ |
| [port-type-badge.md](atoms/port-type-badge.md) | `37:131` | 8 | ❌ inline | ⚠️ |
| [preview-badge.md](atoms/preview-badge.md) | `40:390` | — | ❌ archived | ⚠️ |
| [grid-dot.md](atoms/grid-dot.md) | `40:392` | — | ❌ RF built-in | ✅ |

### Molecules
| Page | Figma ID | Variants | Code Connect | Parity |
|---|---|---|---|---|
| [labeled-handle.md](molecules/labeled-handle.md) | `37:181` | 16 | — LabeledHandle | ✅ |
| [float-slider.md](molecules/float-slider.md) | `17:234` | 3 | — FloatSlider | ✅ |
| [enum-select.md](molecules/enum-select.md) | `17:235` | — | — EnumSelect | ✅ |
| [color-input.md](molecules/color-input.md) | `17:240` | — | — ColorInput | ✅ |
| [connectable-param-row.md](molecules/connectable-param-row.md) | `37:200` | 2 | ❌ inline | ✅ |
| [dynamic-input-controls.md](molecules/dynamic-input-controls.md) | — | — | ❌ inline | ✅ |
| [preview-toolbar.md](molecules/preview-toolbar.md) | `86:100` | 4 | — PreviewToolbar | ✅ |
| [zoom-bar.md](molecules/zoom-bar.md) | `17:314` | — | — ZoomSlider | ✅ |
| [gradient-editor.md](molecules/gradient-editor.md) | `50:4208` | — | — ColorRampEditor | ✅ |
| [typed-edge.md](molecules/typed-edge.md) | — | 8 colors | ❌ code-only | ✅ |
| [minimap.md](molecules/minimap.md) | — | — | ❌ RF built-in | ✅ |
| [properties-info-card.md](molecules/properties-info-card.md) | `37:201` | — | ❌ inline | ✅ |
| [properties-port-row.md](molecules/properties-port-row.md) | `37:206` | — | ❌ inline | ✅ |

### Organisms
| Page | Figma ID | Variants | Code Connect | Parity |
|---|---|---|---|---|
| [node-card.md](organisms/node-card.md) | `88:2435` | 2 | — ShaderNode | ✅ |
| [node-palette.md](organisms/node-palette.md) | `39:289` | — | — NodePalette | ✅ |
| [properties-panel.md](organisms/properties-panel.md) | `39:393` | 2 | — PropertiesPanel | ✅ |
| [floating-preview.md](organisms/floating-preview.md) | `86:261` | — | — FloatingPreview | ✅ |
| [full-window-overlay.md](organisms/full-window-overlay.md) | `86:286` | — | — FullWindowOverlay | ✅ |

### Templates
| Page | Description | Parity |
|---|---|---|
| [node-templates.md](templates/node-templates.md) | All 24 node templates with port/param inventory | ✅ 24/24 |

### Scenes
| Page | Description | Parity |
|---|---|---|
| [app-layouts.md](scenes/app-layouts.md) | 5 layout modes with panel ratios and properties | ✅ 5/5 |

---

## Code Connect Summary

**Status:** Skipped — the Figma file is connected to the **Fantasy-Interactive** GitHub org, but `spendolas/sombra` is on a personal GitHub account. Code Connect can't bridge across orgs.

The 14 component mappings below are documented for reference but not activated in Figma:

| Figma Component | React Component | File |
|---|---|---|
| Handle | `BaseHandle` | `src/components/base-handle.tsx` |
| Separator | `Separator` | `src/components/ui/separator.tsx` |
| Labeled Handle | `LabeledHandle` | `src/components/labeled-handle.tsx` |
| Float Slider | `FloatSlider` | `src/components/NodeParameters.tsx` |
| Enum Select | `EnumSelect` | `src/components/NodeParameters.tsx` |
| Color Input | `ColorInput` | `src/components/NodeParameters.tsx` |
| Zoom Bar | `ZoomSlider` | `src/components/zoom-slider.tsx` |
| Gradient Editor | `ColorRampEditor` | `src/components/ColorRampEditor.tsx` |
| Preview Toolbar | `PreviewToolbar` | `src/components/PreviewToolbar.tsx` |
| Node Card | `ShaderNode` | `src/components/ShaderNode.tsx` |
| Node Palette | `NodePalette` | `src/components/NodePalette.tsx` |
| Properties Panel | `PropertiesPanel` | `src/components/PropertiesPanel.tsx` |
| Floating Preview | `FloatingPreview` | `src/components/FloatingPreview.tsx` |
| Full Window Overlay | `FullWindowOverlay` | `src/components/FullWindowOverlay.tsx` |

---

## Variable Collections

| Collection | ID | Variables | Modes |
|---|---|---|---|
| UI Colors | `17:7` | 14 | Dark, Light |
| Port Types | `17:21` | 8 | Dark, Light |
| Spacing | `17:914` | 6 | Single |
| Radius | `17:921` | 4 | Single |
| Sizes | `43:3517` | 9 | Single |

**Total:** 41 variables across 5 collections

---

## Component Hierarchy

```
Foundations (tokens, typography, icons)
└── Atoms (8 components)
    ├── Handle, Separator, Palette Item, PlusMinus Button
    ├── Category Header, Port Type Badge, Preview Badge, Grid Dot
    └── Molecules (12 components)
        ├── Labeled Handle, Float Slider, Enum Select, Color Input
        ├── Connectable Param Row, Preview Toolbar, Zoom Bar
        ├── Gradient Editor, Properties Info Card, Properties Port Row
        └── Organisms (5 components)
            ├── Node Card, Node Palette, Properties Panel
            ├── Floating Preview, Full Window Overlay
            └── Templates (24 node types)
                └── Scenes (5 app layouts)
```

---

*See also: [IMPLEMENTATION_GUIDE.md](../IMPLEMENTATION_GUIDE.md) for the Figma-first development workflow.*
