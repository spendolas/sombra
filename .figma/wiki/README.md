# Sombra Design System Wiki — V2

Comprehensive documentation of every design system element, matched 1:1 between Figma and code.

**Figma File:** [`gq5i0l617YkXy0GzAZPtqz`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra)
**Approach:** Code-first — React components are the source of truth, Figma components built from code specs
**Code Connect:** Skipped (GitHub org mismatch — Figma file linked to Fantasy-Interactive org, code lives in spendolas/sombra)

---

## V2 Rebuild Summary

V2 was rebuilt from scratch using a **code-driven approach**: every Figma component was created by reading the React source files, extracting exact Tailwind classes, sizes, colors, and layout properties, then building matching Figma components with auto-layout and variable bindings.

**Branch:** `figma-v2`
**Pages:** Foundations | Components | Templates | Scenes

---

## Parity Score: 39/39 ✅

| Level | Total | ✅ Match | Notes |
|---|---|---|---|
| Tokens | 5 collections + 11 text styles | All | 41 variables + 11 text styles, dark mode only |
| Atoms | 7 | 7 | Handle, Separator, Category Header, Palette Item, Plus Minus Button, Node Header, Node Footer |
| Molecules | 10 | 10 | Labeled Handle, Float Slider, Enum Select, Color Input, Connectable Param Row, Preview Toolbar, Zoom Bar, Gradient Editor, Random Display, MiniMap |
| Organisms | 5 | 5 | Node Card, Node Palette, Properties Panel, Floating Preview, Full Window Overlay |
| Templates | 24 | 24 | All node types |
| Scenes | 5 | 5 | All preview modes |

---

## Table of Contents

### Tokens
| Page | Description | Parity |
|---|---|---|
| [colors.md](tokens/colors.md) | UI Colors (14 vars) + Port Types (8 vars) | ✅ 22/22 |
| [spacing.md](tokens/spacing.md) | 6 spacing tokens (xs→2xl) | ✅ 6/6 |
| [radius.md](tokens/radius.md) | 4 radius tokens (sm/md/lg/full) | ✅ 4/4 |
| [sizes.md](tokens/sizes.md) | 9 size tokens (handle→track-h) | ✅ 9/9 |
| [typography.md](tokens/typography.md) | 11 text styles (heading/body/label/mono/port-row) | ✅ 11/11 |

### Atoms
| Page | Figma ID | Variants | Code File | Parity |
|---|---|---|---|---|
| [handle.md](atoms/handle.md) | `106:84` | 16 | base-handle.tsx | ✅ |
| [separator.md](atoms/separator.md) | `106:89` | — | ui/separator.tsx | ✅ |
| [category-header.md](atoms/category-header.md) | `106:92` | — | NodePalette.tsx (inline) | ✅ |
| [palette-item.md](atoms/palette-item.md) | `106:95` | — | NodePalette.tsx (inline) | ✅ |
| [plus-minus-button.md](atoms/plus-minus-button.md) | `106:108` | 4 | ShaderNode.tsx (inline) | ✅ |
| [node-header.md](atoms/node-header.md) | `111:488` | — | base-node.tsx (BaseNodeHeader) | ✅ |
| [node-footer.md](atoms/node-footer.md) | `111:491` | — | base-node.tsx (BaseNodeFooter) | ✅ |

### Molecules
| Page | Figma ID | Variants | Code File | Parity |
|---|---|---|---|---|
| [labeled-handle.md](molecules/labeled-handle.md) | `106:269` | 32 | labeled-handle.tsx | ✅ |
| [float-slider.md](molecules/float-slider.md) | `106:282` | — | NodeParameters.tsx | ✅ |
| [enum-select.md](molecules/enum-select.md) | `106:288` | — | NodeParameters.tsx | ✅ |
| [color-input.md](molecules/color-input.md) | `106:292` | — | NodeParameters.tsx | ✅ |
| [connectable-param-row.md](molecules/connectable-param-row.md) | `106:311` | 2 | ShaderNode.tsx (inline) | ✅ |
| [preview-toolbar.md](molecules/preview-toolbar.md) | `106:352` | 4 | PreviewToolbar.tsx | ✅ |
| [zoom-bar.md](molecules/zoom-bar.md) | `111:930` | — | zoom-slider.tsx | ✅ |
| [gradient-editor.md](molecules/gradient-editor.md) | `111:949` | — | ColorRampEditor.tsx | ✅ |
| [random-display.md](molecules/random-display.md) | `111:954` | — | RandomDisplay.tsx | ✅ |
| [minimap.md](molecules/minimap.md) | `111:963` | — | FlowCanvas.tsx (MiniMap) | ✅ |

### Organisms
| Page | Figma ID | Variants | Code File | Parity |
|---|---|---|---|---|
| [node-card.md](organisms/node-card.md) | `106:405` | 2 | ShaderNode.tsx | ✅ |
| [node-palette.md](organisms/node-palette.md) | `106:453` | — | NodePalette.tsx | ✅ |
| [properties-panel.md](organisms/properties-panel.md) | `106:485` | 2 | PropertiesPanel.tsx | ✅ |
| [floating-preview.md](organisms/floating-preview.md) | `106:498` | — | FloatingPreview.tsx | ✅ |
| [full-window-overlay.md](organisms/full-window-overlay.md) | `106:511` | — | FullWindowOverlay.tsx | ✅ |

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

The 18 component mappings below are documented for reference but not activated in Figma (org mismatch):

| Figma Component | React Component | File |
|---|---|---|
| Handle | `BaseHandle` | `src/components/base-handle.tsx` |
| Separator | `Separator` | `src/components/ui/separator.tsx` |
| Node Header | `BaseNodeHeader` | `src/components/base-node.tsx` |
| Node Footer | `BaseNodeFooter` | `src/components/base-node.tsx` |
| Labeled Handle | `LabeledHandle` | `src/components/labeled-handle.tsx` |
| Float Slider | `FloatSlider` | `src/components/NodeParameters.tsx` |
| Enum Select | `EnumSelect` | `src/components/NodeParameters.tsx` |
| Color Input | `ColorInput` | `src/components/NodeParameters.tsx` |
| Zoom Bar | `ZoomSlider` | `src/components/zoom-slider.tsx` |
| Gradient Editor | `ColorRampEditor` | `src/components/ColorRampEditor.tsx` |
| Random Display | `RandomDisplay` | `src/components/RandomDisplay.tsx` |
| MiniMap | `<MiniMap>` | `src/components/FlowCanvas.tsx` |
| Preview Toolbar | `PreviewToolbar` | `src/components/PreviewToolbar.tsx` |
| Node Card | `ShaderNode` | `src/components/ShaderNode.tsx` |
| Node Palette | `NodePalette` | `src/components/NodePalette.tsx` |
| Properties Panel | `PropertiesPanel` | `src/components/PropertiesPanel.tsx` |
| Floating Preview | `FloatingPreview` | `src/components/FloatingPreview.tsx` |
| Full Window Overlay | `FullWindowOverlay` | `src/components/FullWindowOverlay.tsx` |

---

## Variable Collections (V2)

| Collection | ID | Variables | Modes |
|---|---|---|---|
| UI Colors | `VariableCollectionId:106:2` | 14 | Dark, Light |
| Port Types | `VariableCollectionId:106:17` | 8 | Dark, Light |
| Spacing | `VariableCollectionId:106:26` | 6 | Single |
| Radius | `VariableCollectionId:106:33` | 4 | Single |
| Sizes | `VariableCollectionId:106:38` | 9 | Single |

**Total:** 41 variables across 5 collections

## Text Styles (V2)

| Style | ID | Size | Weight | Letter Spacing | Text Case | Line Height |
|---|---|---|---|---|---|---|
| heading/node-title | `S:ae1da69b…` | 14px | Semi Bold | 0 | ORIGINAL | 150% |
| heading/section | `S:c40fb50e…` | 12px | Semi Bold | 0.6px | UPPER | 150% |
| heading/category | `S:0626cc9a…` | 10px | Semi Bold | 0.5px | UPPER | 150% |
| body/default | `S:d3ec7512…` | 12px | Regular | 0 | ORIGINAL | 150% |
| body/description | `S:fb93df82…` | 12px | Regular | 0 | ORIGINAL | 162.5% |
| body/handle | `S:548a13de…` | 13px | Regular | 0 | ORIGINAL | 150% |
| label/param | `S:ede2674e…` | 10px | Regular | 0 | ORIGINAL | 150% |
| label/category-meta | `S:9d4a9781…` | 10px | Regular | 0.25px | UPPER | 150% |
| mono/value | `S:9d5974b4…` | 12px | Regular | 0 | ORIGINAL | 150% |
| mono/id | `S:1181640d…` | 10px | Regular | 0 | ORIGINAL | 150% |
| port-row/type | `S:3b18697f…` | 11px | Regular | 0 | ORIGINAL | 150% |

**Total:** 11 text styles, 86 TEXT nodes bound (0 unbound)

---

## Component Hierarchy

```
Foundations (tokens, typography)
└── Atoms (7 components)
    ├── Handle, Separator, Palette Item, PlusMinus Button, Category Header
    ├── Node Header, Node Footer
    └── Molecules (10 components)
        ├── Labeled Handle, Float Slider, Enum Select, Color Input
        ├── Connectable Param Row, Preview Toolbar
        ├── Zoom Bar, Gradient Editor, Random Display, MiniMap
        └── Organisms (5 components)
            ├── Node Card, Node Palette, Properties Panel
            ├── Floating Preview, Full Window Overlay
            └── Templates (24 node types)
                └── Scenes (5 app layouts)
```

---

*See also: [IMPLEMENTATION_GUIDE.md](../IMPLEMENTATION_GUIDE.md) for the code-first development workflow.*
