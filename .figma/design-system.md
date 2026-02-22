# Sombra Design System Rules

## Stack
- **Framework:** React 19 + TypeScript (strict)
- **Styling:** Tailwind CSS v4 (Vite plugin, no config file)
- **Component Library:** shadcn/ui (new-york style, neutral base)
- **Icons:** Lucide React
- **State:** Zustand
- **Node Canvas:** @xyflow/react (React Flow v12)

## Figma Tooling

All Figma work is done through the **Claude-in-Chrome MCP extension** on web Figma (`figma.com`). This gives direct access to the Figma Plugin API for both reading and modifying the design file.

**Tools:**
- `mcp__claude-in-chrome__javascript_tool` — Execute Plugin API code in the active Figma tab
- `mcp__claude-in-chrome__read_page` — Read current page structure
- `mcp__claude-in-chrome__navigate` — Open Figma URLs

**Plugin API pattern:** All modifications use an async IIFE:
```js
(async () => {
  const node = await figma.getNodeByIdAsync('17:161');
  // ... modify node properties
  return { success: true };
})()
```

**Key gotchas:**
- `setBoundVariableForPaint` is a static method on `figma.variables`, not on the node
- Instance vector paths cannot be modified — detach or recreate as plain vectors
- Set `layoutSizingHorizontal = 'FILL'` AFTER appending to auto-layout parent
- Swap Handle component variants for connected state — never force colors manually
- Use `await figma.getNodeByIdAsync(id)` (not `figma.getNodeById`) for reliable access
- The MCP Figma tools (`get_design_context`, `get_variable_defs`, etc.) are read-only — use the Chrome extension Plugin API for writes

## Token Structure

### CSS Custom Properties (`src/index.css`)
All design tokens are CSS custom properties on `:root`. Dark theme is default (no `.dark` class toggle — app is dark-first).

**Sombra Palette (custom):**
```
--surface, --surface-alt, --surface-raised, --surface-elevated
--fg, --fg-dim, --fg-subtle, --fg-muted
--edge, --edge-subtle
--indigo, --indigo-hover, --indigo-active
```

All registered in Tailwind `@theme inline` as `--color-*` entries, enabling utility classes like `bg-surface`, `text-fg-dim`, `border-edge`, etc.

**shadcn Tokens (oklch):**
Standard shadcn variable set: `--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`

These are separate from Sombra tokens. shadcn primitives use their own oklch tokens — don't remap Sombra tokens to shadcn tokens.

### Port Type Colors
Semantic colors for shader data types. Defined in `src/components/ShaderNode.tsx` (`getPortColor()`) and `src/components/TypedEdge.tsx` (`PORT_COLORS`):
- float: #d4d4d8, vec2: #34d399, vec3: #60a5fa, vec4: #a78bfa
- color: #fbbf24, sampler2D: #f472b6, fnref: #22d3ee, default: #6b7280

## Component Architecture

### Primitives (shadcn/ui) — `src/components/ui/`
Imported via `npx shadcn@latest add <name>`. Do NOT modify these files directly unless patching API differences.
- Button (cva variants), Input, Slider, Select (compound), Label, Separator, Resizable

### Custom Components — `src/components/`
- `BaseNode` + subcomponents (Header, HeaderTitle, Content, Footer) — node card wrapper
- `BaseHandle` — React Flow handle with `handleColor` + `connected` props
- `LabeledHandle` — handle + label with position-aware layout
- `ShaderNode` — full node renderer (memo'd)
- `TypedEdge` — color-coded bezier edge
- `FlowCanvas` — React Flow canvas with DnD
- `NodePalette` — categorized draggable list
- `PropertiesPanel` — node detail/edit panel
- `NodeParameters` — param controls (FloatSlider, ColorInput, EnumSelect)
- `ZoomSlider` — zoom panel

### Naming Conventions
- PascalCase for components, camelCase for utilities
- `@/` alias maps to `src/`
- shadcn components use `data-slot` attributes
- Custom components use `cn()` (clsx + tailwind-merge)

## Styling Rules
- **Tailwind utility classes** — no CSS modules, no styled-components
- **Dark theme** — base bg `#0f0f1a`, all surfaces use Sombra palette vars
- **No inline `style={{}}` for Sombra tokens** — use Tailwind utility classes (`bg-surface`, `text-fg-dim`, `border-edge`, etc.)
- Only justified inline styles: React Flow component props that require `style` objects, dynamic runtime `handleColor`
- **No custom CSS files** beyond `src/index.css`
- `--radius: 0.625rem` (10px) is the shadcn base radius

## Layout
Three-panel resizable layout (App.tsx):
- Left: NodePalette (18%)
- Center: FlowCanvas (70%) + Preview canvas (30%) — vertical split
- Right: PropertiesPanel (18%)

## Icon Usage
Only Lucide React icons: Maximize, Minus, Plus, GripVerticalIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon

## Asset Management
No images or static assets currently. WebGL renders to canvas. No CDN.

## Responsive Design
Not implemented — fixed fullscreen layout (h-screen w-screen). No breakpoints.

---

# Sync Protocol

## Direction
**Figma is source of truth** — design decisions originate in Figma; code implements them.

## Naming Convention
| Context | Separator | Example |
|---|---|---|
| Figma variable | `/` | `surface/alt` |
| CSS variable | `-` | `--surface-alt` |
| Tailwind class | `-` | `bg-surface-alt` |

## Workflow

### Figma → Code (primary flow)
1. You change a Figma variable or update a component
2. You share the URL or tell me what changed
3. I read via `get_variable_defs` or `get_design_context`
4. I update CSS/Tailwind, preserving existing code patterns and conventions
5. I flag any changes that would be difficult or costly to implement **before** writing code
6. I ask rather than assume when anything is ambiguous

### Code → Figma (rare — Figma leads)
1. I need to change a token in code (e.g., fixing a bug, adding a new token)
2. I update this file (`.figma/design-system.md`) with what changed
3. You update Figma variables to match

### Status Tracking
Every sync action updates `DESIGN_SYSTEM_PROGRESS.md` with what changed and current status.

---

# Figma Variable Specification

## Variable Collection 1: "UI Colors"
**Modes:** Dark, Light

| Figma Variable | CSS Variable | Tailwind Class | Dark | Light |
|---|---|---|---|---|
| `surface/default` | `--surface` | `bg-surface` | `#0f0f1a` | `#f0f0f6` |
| `surface/alt` | `--surface-alt` | `bg-surface-alt` | `#1a1a2e` | `#e4e4ee` |
| `surface/raised` | `--surface-raised` | `bg-surface-raised` | `#252538` | `#d4d4e2` |
| `surface/elevated` | `--surface-elevated` | `bg-surface-elevated` | `#2d2d44` | `#ffffff` |
| `fg/default` | `--fg` | `text-fg` | `#e8e8f0` | `#1a1a2e` |
| `fg/dim` | `--fg-dim` | `text-fg-dim` | `#b8b8c8` | `#3a3a52` |
| `fg/subtle` | `--fg-subtle` | `text-fg-subtle` | `#88889a` | `#5a5a6e` |
| `fg/muted` | `--fg-muted` | `text-fg-muted` | `#5a5a6e` | `#8888a0` |
| `edge/default` | `--edge` | `border-edge` | `#3a3a52` | `#c4c4d6` |
| `edge/subtle` | `--edge-subtle` | `border-edge-subtle` | `#2a2a3e` | `#d8d8e6` |
| `indigo/default` | `--indigo` | `bg-indigo` | `#6366f1` | `#4f46e5` |
| `indigo/hover` | `--indigo-hover` | `bg-indigo-hover` | `#818cf8` | `#6366f1` |
| `indigo/active` | `--indigo-active` | `bg-indigo-active` | `#4f46e5` | `#3730a3` |

**Total: 13 variables × 2 modes**

## Variable Collection 2: "Port Types"
**Modes:** Dark, Light

| Figma Variable | Dark | Light |
|---|---|---|
| `float` | `#d4d4d8` | `#71717a` |
| `vec2` | `#34d399` | `#059669` |
| `vec3` | `#60a5fa` | `#2563eb` |
| `vec4` | `#a78bfa` | `#7c3aed` |
| `color` | `#fbbf24` | `#d97706` |
| `sampler2D` | `#f472b6` | `#db2777` |
| `fnref` | `#22d3ee` | `#0891b2` |
| `default` | `#6b7280` | `#6b7280` |

**Total: 8 variables × 2 modes**

Light mode port colors use the **-600 Tailwind stop** of the same hue — darker for contrast on white surfaces while preserving the same color identity.

## Variable Collection 3: "Spacing"
**Modes:** Default (single mode)

| Figma Variable | Value (px) | Tailwind Equivalent |
|---|---|---|
| `spacing/xs` | 4 | `gap-1`, `p-1` |
| `spacing/sm` | 6 | `gap-1.5`, `p-1.5` |
| `spacing/md` | 8 | `gap-2`, `p-2` |
| `spacing/lg` | 12 | `gap-3`, `p-3` |
| `spacing/xl` | 16 | `gap-4`, `p-4` |
| `spacing/2xl` | 24 | `gap-6`, `p-6` |

**Total: 6 FLOAT variables × 1 mode**

Used for `itemSpacing`, `padding`, and `width` bindings on auto-layout frames. Bound to Foundations spacing bars and Composition frames (Node Palette padding/gaps, Properties Panel padding/gaps).

## Variable Collection 4: "Radius"
**Modes:** Default (single mode)

| Figma Variable | Value (px) | Usage |
|---|---|---|
| `radius/sm` | 4 | Palette items, port rows |
| `radius/md` | 6 | Nodes, inputs, buttons |
| `radius/lg` | 8 | Panel sections, info cards |
| `radius/full` | 9999 | Handles, slider thumbs |

**Total: 4 FLOAT variables × 1 mode**

Bound to `topLeftRadius`/`topRightRadius`/`bottomLeftRadius`/`bottomRightRadius` on Foundations radius samples and Composition node frames.

---

# Code Connect Mappings

Components are built in Figma file `gq5i0l617YkXy0GzAZPtqz`. Code Connect requires published components (team library). When the file is moved to a team project, activate mappings with `add_code_connect_map` using the node IDs below.

### Atoms
| Figma Component | Node ID | Code File | React Component | Key Props |
|---|---|---|---|---|
| Handle | `17:161` | `src/components/base-handle.tsx` | `BaseHandle` | `handleColor`, `connected`, `type` |
| Palette Item | `17:248` | `src/components/NodePalette.tsx` | (inline) | `label`, `category` |
| PlusMinus Button | `17:258` | `src/components/ShaderNode.tsx` | (inline) | `onClick` |
| Category Header | `37:96` | `src/components/NodePalette.tsx` | (inline `<h3>`) | `text` |
| Port Type Badge | `37:131` | `src/components/PropertiesPanel.tsx` | (inline `<span>`) | `portType` |
| Separator | `37:132` | `src/components/ui/separator.tsx` | `Separator` | — |

### Molecules
| Figma Component | Node ID | Code File | React Component | Key Props |
|---|---|---|---|---|
| Labeled Handle | `37:181` | `src/components/labeled-handle.tsx` | `LabeledHandle` | `title`, `type`, `position`, `handleColor`, `connected` |
| Float Slider | `17:234` | `src/components/NodeParameters.tsx` | `FloatSlider` | `param`, `value`, `disabled` |
| Enum Select | `17:235` | `src/components/NodeParameters.tsx` | `EnumSelect` | `param`, `value` |
| Color Input | `17:240` | `src/components/NodeParameters.tsx` | `ColorInput` | `param`, `value` |
| Zoom Bar | `17:314` | `src/components/zoom-slider.tsx` | `ZoomSlider` | `position` |
| Connectable Param Row | `37:200` | `src/components/ShaderNode.tsx` | (inline) | `param`, `connected` |
| Properties Info Card | `37:201` | `src/components/PropertiesPanel.tsx` | `PropertiesPanel` | `selectedNode` |
| Properties Port Row | `37:206` | `src/components/PropertiesPanel.tsx` | (inline) | `port`, `type` |
| Gradient Editor | `50:4208` | `src/components/ColorRampEditor.tsx` | `ColorRampEditor` | `nodeId`, `data` |

### Organisms
| Figma Component | Node ID | Code File | React Component | Key Props |
|---|---|---|---|---|
| Node Card | `40:649` | `src/components/ShaderNode.tsx` | `ShaderNode` | `type`, `params`, `selected` + 19 boolean + 1 text property |
| Node Palette | `39:289` | `src/components/NodePalette.tsx` | `NodePalette` | — |
| Properties Panel | `39:393` | `src/components/PropertiesPanel.tsx` | `PropertiesPanel` | `selectedNode` |

---

# Figma Library Structure (Atomic Hierarchy)

**File:** `gq5i0l617YkXy0GzAZPtqz` — [Sombra on Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra)

**Architecture:** Atomic design — Atoms → Molecules → Organisms → Templates. Every component at level N is composed of **instances** of level N-1 components. Changes cascade automatically.

```
Page: Foundations (~102 elements)
├── UI Color swatches (4 groups: Surface, Foreground, Edge, Indigo — variable-bound fills + hex labels)
├── Port Type swatches (8 types: circle handles + rectangles + SF Mono labels)
├── Typography specimens (10 text styles applied)
├── Spacing scale (6 bars: xs/sm/md/lg/xl/2xl — width bound to Spacing variables, labeled)
└── Radius samples (4 rectangles: sm/md/lg/full — corners bound to Radius variables, labeled)

Page: Atoms (8 components — indivisible building blocks, no nested Sombra instances)
├── Category Header (37:96) — COMPONENT, uppercase section label (fg/subtle, Caption/Semibold)
├── Port Type Badge (37:131) — COMPONENT_SET, 8 variants: portType — mono text colored by port type
├── Separator (37:132) — COMPONENT, 1px horizontal divider (edge/subtle fill)
├── Handle (17:161) — COMPONENT_SET, 16 variants: portType (8) × connected (true/false)
├── Palette Item (17:248) — COMPONENT_SET, 2 variants: state (default/hover)
├── PlusMinus Button (17:258) — COMPONENT_SET, 4 variants: type (plus/minus) × state (enabled/disabled)
├── Preview Badge (40:390) — COMPONENT, "PREVIEW" label (surface/raised bg, fg/dim text, radius/sm)
└── Grid Dot (40:392) — COMPONENT, 4px circle (edge/subtle fill, radius/full)

Page: Molecules (12 components — combine atom instances)
├── Labeled Handle (37:181) — COMPONENT_SET, 16 variants: position (left/right) × portType (8)
│   └── Nests: 1× Atoms/Handle instance (connected overridable)
│   └── Label: layoutSizingHorizontal=FILL, textAlignHorizontal=RIGHT for right-position
├── Float Slider (17:234) — COMPONENT_SET, 3 variants: state (default/disabled/connected)
├── Enum Select (17:235) — COMPONENT, label + trigger frame
├── Color Input (17:240) — COMPONENT, label + color swatch
├── Zoom Bar (17:314) — COMPONENT, minus/track/plus/percentage
├── Connectable Param Row (37:200) — COMPONENT_SET, 2 variants: state (unwired/wired)
│   └── Nests: 1× Atoms/Handle + 1× Molecules/Float Slider instances
├── Properties Info Card (37:201) — COMPONENT, node info card
│   └── Nests: 1× Atoms/Category Header instance
├── Properties Port Row (37:206) — COMPONENT, port name + type badge
│   └── Nests: 1× Atoms/Port Type Badge instance
├── Dynamic Input Controls (40:393) — COMPONENT, minus/count/plus row
│   └── Nests: 2× Atoms/PlusMinus Button instances
├── Typed Edge (40:432) — COMPONENT_SET, 8 variants: portType — colored bezier wire
│   └── Stroke bound to Port Types variables
├── MiniMap (40:433) — COMPONENT, semi-transparent overlay with node indicators
│   └── Fills: surface/alt (85% opacity), indigo/default node rectangles
└── Gradient Editor (50:4208) — COMPONENT, vertical auto-layout (spacing/md gap)
    └── Gradient Bar (FILL × 24px, radius/md, edge/default stroke, linear gradient fill)
    └── Stop Markers Row (FILL × 16px, absolute child ellipses 12×12)
    └── Controls Row (horizontal auto-layout, spacing/xs gap: swatch + position + add/remove)
    └── Preset Selector (Enum Select molecule instance)

Page: Organisms (3 components — combine molecule/atom instances into UI sections)
├── Node Card (40:649) — COMPONENT_SET, 2 variants: selected (true/false)
│   └── 19 boolean properties + 1 text property (Title)
│   └── Boolean slots: Output 1-2, Input 1-5, Dynamic Buttons, Connectable 1-5,
│       Param Separator, Enum 1-2, Slider 1-2, Color Picker
│   └── Default: all ON (kitchen sink). Templates toggle OFF unused slots.
│   └── Nests: Labeled Handle ×7, Connectable Param Row ×5, Dynamic Input Controls ×1,
│       Enum Select ×2, Float Slider ×2, Color Input ×1, Separator ×2
├── Node Palette (39:289) — COMPONENT, 200px wide, 5 category groups with 20 palette items
│   └── Nests: Category Header ×5, Palette Item ×20, Separator ×4
└── Properties Panel (39:393) — COMPONENT_SET, 2 variants: state (empty/selected)
    └── Nests: Category Header ×4, Info Card ×1, Port Row ×4, Float Slider ×1, Enum Select ×1

Page: Templates (22 items — 20 node templates + 2 scene templates)
├── Node Templates (5-column grid by category):
│   ├── INPUT: Number, Color, Vec2, UV Coordinates, Time, Resolution
│   ├── MATH: Arithmetic, Trig, Mix, Smoothstep, Remap, Turbulence, Ridged
│   ├── NOISE: Noise, FBM, Domain Warp
│   ├── COLOR: HSV to RGB, Brightness/Contrast, Color Ramp
│   └── OUTPUT: Fragment Output
├── Default Graph — Time → Noise → Fragment Output (3 Node Card + 2 Typed Edge instances)
└── Sombra App (1440×900) — 3-panel layout (259/922/259px):
    Left: Node Palette instance; Center: Canvas (Grid Dots, Zoom Bar, MiniMap);
    Preview (Preview Badge); Right: Properties Panel instance

Page: Archive — Captures (4 frames)
└── Previous session capture frames (preserved)
```

**Cascade Chain (core benefit):**
```
Atoms/Handle (change vec2 color)
  → Molecules/Labeled Handle (nested Handle instance updates)
    → Molecules/Connectable Param Row (nested Handle instance updates)
      → Organisms/Node Card (nested molecule instances update)
        → Templates/all 19 node templates, Default Graph, Sombra App
```

**Component Totals:** 23 components (8 atoms + 12 molecules + 3 organisms) + 22 template items

**Variable Collections (4 total, 31 variables):**
- UI Colors: 13 variables × 2 modes (Dark/Light) — `VariableCollectionId:17:7`
- Port Types: 8 variables × 2 modes (Dark/Light) — `VariableCollectionId:17:21`
- Spacing: 6 FLOAT variables × 1 mode (Default) — `VariableCollectionId:17:914`
- Radius: 4 FLOAT variables × 1 mode (Default) — `VariableCollectionId:17:921`

**Text Styles:** 10 styles (Caption/Regular, Caption/Semibold, Caption/Mono, Small/Regular, Small/Mono, XS/Regular, XS/Semibold, Body, SM/Semibold, SM/Medium)
