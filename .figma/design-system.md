# Sombra Design System Rules

## Stack
- **Framework:** React 19 + TypeScript (strict)
- **Styling:** Tailwind CSS v4 (Vite plugin, no config file)
- **Component Library:** shadcn/ui (new-york style, neutral base)
- **Icons:** Lucide React
- **State:** Zustand
- **Node Canvas:** @xyflow/react (React Flow v12)

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

---

# Code Connect Mappings

Components are built in Figma file `gq5i0l617YkXy0GzAZPtqz`. Code Connect requires published components (team library). When the file is moved to a team project, activate mappings with `add_code_connect_map` using the node IDs below.

| Figma Component | Node ID | Code File | React Component | Key Props |
|---|---|---|---|---|
| Handle | `17:161` | `src/components/base-handle.tsx` | `BaseHandle` | `handleColor`, `connected`, `type` |
| Labeled Handle | `17:211` | `src/components/labeled-handle.tsx` | `LabeledHandle` | `title`, `type`, `position`, `handleColor`, `connected` |
| Float Slider | `17:234` | `src/components/NodeParameters.tsx` | `FloatSlider` | `param`, `value`, `disabled` |
| Enum Select | `17:235` | `src/components/NodeParameters.tsx` | `EnumSelect` | `param`, `value` |
| Color Input | `17:240` | `src/components/NodeParameters.tsx` | `ColorInput` | `param`, `value` |
| Palette Item | `17:248` | `src/components/NodePalette.tsx` | (inline) | `label`, `category` |
| PlusMinus Button | `17:258` | `src/components/ShaderNode.tsx` | (inline) | `onClick` |
| Node Card | `17:302` | `src/components/ShaderNode.tsx` | `ShaderNode` | `type`, `params`, `selected` |
| Properties Info Card | `17:303` | `src/components/PropertiesPanel.tsx` | `PropertiesPanel` | `selectedNode` |
| Properties Port Row | `17:306` | `src/components/PropertiesPanel.tsx` | (inline) | `port`, `type` |
| Properties Param Box | `17:309` | `src/components/PropertiesPanel.tsx` | (inline) | `params` |
| Zoom Bar | `17:314` | `src/components/zoom-slider.tsx` | `ZoomSlider` | `position` |

---

# Figma Library Structure (Built)

**File:** `gq5i0l617YkXy0GzAZPtqz` — [Sombra on Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra)

```
Page: Foundations (104 elements)
├── UI Color swatches (4 groups: Surface, Foreground, Edge, Indigo — variable-bound fills + hex labels)
├── Port Type swatches (8 types: circle handles + rectangles + SF Mono labels)
├── Typography specimens (10 text styles applied)
├── Spacing scale (4/6/8/12/16/24px bars)
└── Radius samples (4/6/8/12/full rounded rectangles)

Page: Primitives (7 components)
├── Handle — COMPONENT_SET, 16 variants: portType (8) × connected (true/false)
├── Labeled Handle — COMPONENT_SET, 16 variants: position (left/right) × portType (8)
├── Float Slider — COMPONENT_SET, 3 variants: state (default/disabled/connected)
├── Enum Select — COMPONENT, label + trigger frame
├── Color Input — COMPONENT, label + color swatch
├── Palette Item — COMPONENT_SET, 2 variants: state (default/hover)
└── PlusMinus Button — COMPONENT_SET, 4 variants: type (plus/minus) × state (enabled/disabled)

Page: Components (5 components)
├── Node Card — COMPONENT_SET, 2 variants: selected (true/false), header + outputs + inputs + params
├── Properties Info Card — COMPONENT, title + type/id subtitle
├── Properties Port Row — COMPONENT, port name + type label + color dot
├── Properties Param Box — COMPONENT, section header + param rows
└── Zoom Bar — COMPONENT, minus/track/plus/percentage

Page: Compositions (5 frames)
├── Node Palette — all 19 nodes in 6 categories (INPUT/NOISE/TRANSFORM/MATH/COLOR/OUTPUT)
├── Noise node — outputs (value/fn), input (coords), connectable params (Scale/Phase), enum (Noise Type)
├── Arithmetic node — selected variant with ±buttons, A/B inputs, result output, operation enum
├── Fragment Output — single color input
└── Properties Panel — info card + inputs/outputs sections + parameters with enum dropdown

Page: App Layout (1 frame)
└── Sombra App — 1440×900 wireframe, 3-panel layout (18%/64%/18%), dot grid canvas,
    node cards with connection wire, shader preview gradient, zoom bar

Page: Archive — Captures (4 frames)
└── Previous session capture frames (preserved)
```

**Variable Collections:**
- UI Colors: 13 variables × 2 modes (Dark/Light) — `VariableCollectionId:17:7`
- Port Types: 8 variables × 2 modes (Dark/Light) — `VariableCollectionId:17:21`

**Text Styles:** 10 styles (Caption/Regular, Caption/Semibold, Caption/Mono, Small/Regular, Small/Mono, XS/Regular, XS/Semibold, Body, SM/Semibold, SM/Medium)
