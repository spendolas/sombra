# Sombra Design System — Progress Tracker

## Current Phase
**Phase 2: Figma Recreation** — ✅ Complete (Design system built + finalized via Plugin API)

## Status Summary
| Phase | Status |
|---|---|
| Phase 1: Audit | ✅ Complete |
| Phase 2: Figma Recreation | ✅ Complete |
| Phase 3: Code Connect | 🚧 Blocked (requires team library publish) |
| Phase 4: Ongoing Sync | ⬜ Not Started |

## Completed Tasks
- [x] Initial codebase scan (tokens, components, patterns)
- [x] Identify all color tokens (Sombra palette + shadcn oklch + port type colors)
- [x] Identify typography scale (fonts, sizes, weights)
- [x] Identify spacing / sizing patterns
- [x] Identify border radii, shadows, transitions
- [x] Catalog all UI components and variations (7 shadcn + 9 custom)
- [x] Note inconsistencies and duplicates (15 issues found)
- [x] Produce audit summary document
- [x] Write `.figma/design-system.md` rules for Figma MCP
- [x] Derive light mode color values with contrast ratios
- [x] Complete variable specification for both modes
- [x] **Sprint 5.75:** Unify design tokens in code (13 CSS vars renamed, registered with Tailwind v4)
- [x] **Sprint 5.75:** Migrate 48 inline `style={{}}` to Tailwind utility classes across 8 files
- [x] Update `.figma/design-system.md` with new token names, sync protocol, Code Connect spec
- [x] Update `DESIGN_SYSTEM_PROGRESS.md` variable spec tables to match code
- [x] Create `public/design-system.html` visual reference page

## Pending Tasks
- [x] **Phase 2:** Create variable collections in Figma (UI Colors: 13 vars + Port Types: 8 vars, both Dark/Light)
- [x] **Phase 2:** Create text styles in Figma (10 styles: Inter + SF Mono at 10-14px)
- [x] **Phase 2:** Build Foundations page (color swatches, type specimens, spacing, radius — all variable-bound)
- [x] **Phase 2:** Build Primitive components (Handle 16 variants, Labeled Handle 16 variants, Float Slider 3 variants, Enum Select, Color Input, Palette Item 2 variants, PlusMinus Button 4 variants)
- [x] **Phase 2:** Build Composite components (Node Card 2 variants, Properties Info Card, Properties Port Row, Properties Param Box, Zoom Bar)
- [x] **Phase 2:** Build Compositions page (Node Palette with all 19 nodes, Noise/Arithmetic/Fragment Output example nodes, Properties Panel)
- [x] **Phase 2:** Build App Layout wireframe (1440×900, 3-panel layout with dot grid canvas, wire, shader preview)
- [x] **Phase 2:** Set up page structure (Archive — Captures, Foundations, Primitives, Components, Compositions, App Layout)
- [ ] **Phase 3:** Publish components to team library (requires moving file from Drafts to team project)
- [ ] **Phase 3:** Map Figma components to code files via Code Connect (node IDs documented in `.figma/design-system.md`)
- [ ] **Phase 3:** Document prop mappings

## Open Questions
1. ~~Should the dual color system be unified?~~ → **Resolved: Yes** (Decision #1)
2. ~~Dark-only or light+dark?~~ → **Resolved: Both modes** (Decision #2)
3. ~~Port type colors: separate or main palette?~~ → **Resolved: Separate collection** (Decision #3)
4. ~~Existing Figma file?~~ → **Resolved: Yes** — `gq5i0l617YkXy0GzAZPtqz` (empty, clean slate)
5. Approve light mode palette proposal? (pending review)

## Decisions Made
1. **Unify color systems** — Merge the Sombra custom palette and shadcn oklch tokens into a single token set. Sombra palette values are the source of truth; shadcn vars kept separate for shadcn primitives. Custom components use Tailwind utility classes (`bg-surface`, `text-fg-dim`, etc.).
2. **Light + Dark modes** — Support both themes. Figma variables will have two modes. Dark is the default/primary; light mode values specified in variable tables below.
3. **Port type colors: separate collection** — Shader data-type colors (float, vec2, vec3, vec4, color, sampler2D, fnref) live in a dedicated "Port Types" Figma variable collection, isolated from the UI palette.
4. **Token rename (Sprint 5.75)** — All 13 CSS vars renamed for clarity: `--bg-primary` → `--surface`, `--text-primary` → `--fg`, `--border-primary` → `--edge`, `--accent-primary` → `--indigo`, etc. Old names are fully retired.

---

# Phase 2: Figma Variable Specification

## Figma File
- **File key:** `gq5i0l617YkXy0GzAZPtqz`
- **URL:** https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra

## Variable Collection 1: "UI Colors"
**Modes:** Dark, Light

### Surfaces

| Figma Variable | CSS Variable | Tailwind Class | Dark | Light |
|---|---|---|---|---|
| `surface/default` | `--surface` | `bg-surface` | `#0f0f1a` | `#f0f0f6` |
| `surface/alt` | `--surface-alt` | `bg-surface-alt` | `#1a1a2e` | `#e4e4ee` |
| `surface/raised` | `--surface-raised` | `bg-surface-raised` | `#252538` | `#d4d4e2` |
| `surface/elevated` | `--surface-elevated` | `bg-surface-elevated` | `#2d2d44` | `#ffffff` |

### Foreground

| Figma Variable | CSS Variable | Tailwind Class | Dark | Light |
|---|---|---|---|---|
| `fg/default` | `--fg` | `text-fg` | `#e8e8f0` | `#1a1a2e` |
| `fg/dim` | `--fg-dim` | `text-fg-dim` | `#b8b8c8` | `#3a3a52` |
| `fg/subtle` | `--fg-subtle` | `text-fg-subtle` | `#88889a` | `#5a5a6e` |
| `fg/muted` | `--fg-muted` | `text-fg-muted` | `#5a5a6e` | `#8888a0` |

### Edges (Borders)

| Figma Variable | CSS Variable | Tailwind Class | Dark | Light |
|---|---|---|---|---|
| `edge/default` | `--edge` | `border-edge` | `#3a3a52` | `#c4c4d6` |
| `edge/subtle` | `--edge-subtle` | `border-edge-subtle` | `#2a2a3e` | `#d8d8e6` |

### Indigo (Accent)

| Figma Variable | CSS Variable | Tailwind Class | Dark | Light |
|---|---|---|---|---|
| `indigo/default` | `--indigo` | `bg-indigo` | `#6366f1` | `#4f46e5` |
| `indigo/hover` | `--indigo-hover` | `bg-indigo-hover` | `#818cf8` | `#6366f1` |
| `indigo/active` | `--indigo-active` | `bg-indigo-active` | `#4f46e5` | `#3730a3` |

**Total: 13 variables × 2 modes**

### shadcn Token Mapping (CSS vars → Figma vars)

Once variables are created, the CSS token bridge:
| CSS Variable | Maps to Figma Variable |
|---|---|
| `--background` | `surface/default` |
| `--foreground` | `fg/default` |
| `--card` | `surface/raised` |
| `--card-foreground` | `fg/default` |
| `--primary` | `indigo/default` |
| `--primary-foreground` | `surface/default` |
| `--secondary` | `surface/raised` |
| `--secondary-foreground` | `fg/default` |
| `--muted` | `surface/raised` |
| `--muted-foreground` | `fg/subtle` |
| `--accent` | `surface/raised` |
| `--accent-foreground` | `fg/default` |
| `--destructive` | (separate — `#ef4444` / `#dc2626`) |
| `--border` | `edge/default` |
| `--input` | `edge/subtle` |
| `--ring` | `indigo/default` |

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

## Changelog

### 2026-02-21 (Session 4 — Design System Finalization)
- Created "Spacing" variable collection: 6 FLOAT variables (xs=4, sm=6, md=8, lg=12, xl=16, 2xl=24)
- Created "Radius" variable collection: 4 FLOAT variables (sm=4, md=6, lg=8, full=9999)
- Updated Foundations page: spacing bars width-bound to Spacing variables, radius samples corner-bound to Radius variables, labels updated to show variable names, removed orphan 12px radius sample
- Fixed Float Slider component: reduced track-container height from 100px to 16px for compact display
- Fixed font style discovery: "Semi Bold" (with space) not "SemiBold" — was causing silent script failures
- Rebuilt all 5 Compositions with real component instances (previously raw frames):
  - Node Palette: 19 Palette Item instances in 5 categories, spacing-variable-bound gaps
  - Noise node: 8 instances (Labeled Handle, Handle, Float Slider, Enum Select)
  - Arithmetic node: 6 instances (Labeled Handle, PlusMinus Button, Enum Select), selected variant
  - Fragment Output: 1 Labeled Handle instance
  - Properties Panel: 7 instances (Info Card, Port Row, Float Slider, Enum Select)
- Rebuilt App Layout wireframe with 8 component instances: Palette Items, Info Card, Port Row, Zoom Bar, plus dot grid, mini nodes, bezier wire, gradient preview
- Total: 4 variable collections, 31 variables, 12 components, 10 text styles
- Updated `.figma/design-system.md` with Spacing/Radius specs and updated library inventory

### 2026-02-21 (Session 3b — Audit & Fix)
- Audited all pages, components, and variant sets for correctness
- Fixed 11 auto-layout containers with h=1px (wrong `primaryAxisSizingMode: "FIXED"` → `"AUTO"`)
- Deleted 2 orphaned thumb ellipses from Primitives page
- Unwrapped 6 variant sets from unnecessary container frames (moved COMPONENT_SETs to page level)
- Added auto-layout with horizontal wrap + spacing to all 6 COMPONENT_SET nodes
- Re-arranged Primitives and Components pages with proper element spacing
- Final audit: 0 issues remaining across all 6 pages, 12 components, 21 variables, 10 text styles

### 2026-02-21 (Session 3 — Plugin API Build)
- Built entire Figma design system programmatically via Plugin API (executed directly in browser)
- Created 2 variable collections: "UI Colors" (13 vars × 2 modes) + "Port Types" (8 vars × 2 modes)
- Created 10 text styles (Inter Regular/Semibold/Medium + SF Mono at 10-14px sizes)
- Built Foundations page: UI Color swatches, Port Type swatches, Typography specimens, Spacing scale, Radius samples — all fills bound to variables
- Built 7 Primitive component sets: Handle (16 variants), Labeled Handle (16), Float Slider (3), Enum Select, Color Input, Palette Item (2), PlusMinus Button (4)
- Built 5 Composite components: Node Card (2 variants with selection glow), Properties Info Card, Port Row, Param Box, Zoom Bar
- Built Compositions: Node Palette (all 19 nodes in 6 categories), 3 example nodes (Noise, Arithmetic selected, Fragment Output), full Properties Panel
- Built 1440×900 App Layout wireframe: 3-panel layout, dot grid canvas, node cards, connection wire, shader preview gradient, zoom bar
- Set up 6 pages: Archive — Captures, Foundations, Primitives, Components, Compositions, App Layout
- Documented all 12 component node IDs in `.figma/design-system.md` for future Code Connect activation
- Code Connect blocked: requires published components (file is in Drafts, not team library)

### 2026-02-21 (Session 2)
- Updated `.figma/design-system.md`: new token names, sync protocol, Code Connect spec, library structure
- Updated `DESIGN_SYSTEM_PROGRESS.md`: variable spec tables now use new names (`surface/default` not `bg/primary`)
- Created `public/design-system.html` standalone visual reference page
- Captured 3 pages into Figma file via `generate_figma_design`

### 2026-02-21 (Session 1)
- Created DESIGN_SYSTEM_PROGRESS.md
- Started Phase 1: Audit — scanned all src/ files
- Completed full audit: 3 color systems, 16 components, 15 issues cataloged
- Audit summary written (see below)
- Decisions made: unify color systems, light+dark modes, port colors as separate collection
- Phase 2 started: wrote `.figma/design-system.md`, derived light mode palette, built variable spec
- Figma file: `gq5i0l617YkXy0GzAZPtqz` (empty, ready for variable collections)

---

# Phase 1: Design System Audit

## 1. Color Tokens

### 1A. Sombra Custom Palette (CSS vars in `src/index.css`)

The primary color system used by all custom components. Applied via Tailwind utility classes (`bg-surface`, `text-fg-dim`, `border-edge`, etc.).

| Token | Hex | Usage |
|---|---|---|
| `--surface` | `#0f0f1a` | App background, canvas bg |
| `--surface-alt` | `#1a1a2e` | Side panels |
| `--surface-raised` | `#252538` | Node headers, input bg, tags |
| `--surface-elevated` | `#2d2d44` | Node body, hover states |
| `--fg` | `#e8e8f0` | Main text |
| `--fg-dim` | `#b8b8c8` | Descriptions, section headers |
| `--fg-subtle` | `#88889a` | Labels, small caps |
| `--fg-muted` | `#5a5a6e` | IDs, source labels, disabled |
| `--edge` | `#3a3a52` | Panel borders, node input borders |
| `--edge-subtle` | `#2a2a3e` | Separators, grid dots |
| `--indigo` | `#6366f1` | Selection highlight, minimap |
| `--indigo-hover` | `#818cf8` | Hover state |
| `--indigo-active` | `#4f46e5` | Active/pressed state |

### 1B. shadcn/ui Tokens (oklch, also in `src/index.css`)

Used by shadcn primitives (Button, Input, Slider, Select, etc.) via Tailwind classes.

| Token | Value | Maps to |
|---|---|---|
| `--background` | `oklch(0.145 0 0)` | Near-black body bg |
| `--foreground` | `oklch(0.985 0 0)` | Near-white text |
| `--card` | `oklch(0.205 0 0)` | Card surfaces |
| `--primary` | `oklch(0.922 0 0)` | Primary buttons |
| `--secondary` | `oklch(0.269 0 0)` | Secondary surfaces |
| `--muted` | `oklch(0.269 0 0)` | Muted surfaces (= secondary) |
| `--accent` | `oklch(0.269 0 0)` | Accent surfaces (= secondary) |
| `--destructive` | `oklch(0.704 0.191 22.216)` | Error/danger red |
| `--border` | `oklch(1 0 0 / 10%)` | Borders (white 10%) |
| `--input` | `oklch(1 0 0 / 15%)` | Input borders (white 15%) |
| `--ring` | `oklch(0.556 0 0)` | Focus ring |
| `--radius` | `0.625rem` (10px) | Base radius |

### 1C. Port Type Colors (hardcoded hex, duplicated)

Semantic colors for shader data types. Defined identically in **two separate locations**.

| Port Type | Hex | Tailwind Equiv |
|---|---|---|
| `float` | `#d4d4d8` | zinc-300 |
| `vec2` | `#34d399` | emerald-400 |
| `vec3` | `#60a5fa` | blue-400 |
| `vec4` | `#a78bfa` | violet-400 |
| `color` | `#fbbf24` | amber-400 |
| `sampler2D` | `#f472b6` | pink-400 |
| `fnref` | `#22d3ee` | cyan-400 |
| Default | `#6b7280` / `#9ca3af` | gray-500 / gray-400 (inconsistent!) |

**Sources:** `src/components/ShaderNode.tsx:getPortColor()` and `src/components/TypedEdge.tsx:PORT_COLORS`

### 1D. Other Hardcoded Colors

| Color | Where | Purpose |
|---|---|---|
| `#000` | App.tsx | Preview panel bg |
| `#6b7280` | base-handle.tsx | Handle fallback border |
| `bg-red-900` / `border-red-700` | ShaderNode.tsx | Unknown node error state |
| `rgba(15, 15, 26, 0.85)` | FlowCanvas.tsx | MiniMap mask |

---

## 2. Typography

### Font Family
- **Primary:** `Inter, system-ui, Avenir, Helvetica, Arial, sans-serif` (set on `:root`)
- **Monospace:** Tailwind default `font-mono` (used for node IDs, port types)

### Font Sizes in Use

| Size | Tailwind | Usage |
|---|---|---|
| 10px | `text-[10px]` | Param labels, category headers, node IDs, source labels |
| 11px | `text-[11px]` | Port info rows (properties panel) |
| 12px | `text-xs` | Palette items, section headers, descriptions, select items |
| 13px | raw CSS `font-size: 13px` | React Flow node base (index.css) |
| 14px | `text-sm` | Node titles, property name, shadcn defaults |
| 16px | `text-base` | Input default (pre-md breakpoint) |

### Font Weights

| Weight | Tailwind | Usage |
|---|---|---|
| 400 | `font-normal` (default) | Body text |
| 500 | `font-medium` | Property name, shadcn buttons/labels |
| 600 | `font-semibold` | Node titles, section headers |

### Text Styles
- `uppercase tracking-wider` — Palette category headers
- `uppercase tracking-wide` — Properties subcategory labels (note: subtly different from `tracking-wider`)
- `tabular-nums` — Numeric displays (zoom %, slider values)
- `font-mono` — Node IDs, port type labels

---

## 3. Spacing

No explicit spacing scale defined — relies on Tailwind defaults.

**Commonly used values:**
- Gaps: `gap-1` (4px), `gap-2` (8px)
- Padding: `p-1` (4px), `p-3` (12px), `p-4` (16px)
- Horizontal: `px-1`, `px-2`, `px-3`
- Vertical: `py-0.5`, `py-1`, `py-1.5`, `py-2`
- Margins: `mb-1`, `mb-2`, `mb-3`, `mb-4`
- Stack: `space-y-1`, `space-y-1.5`, `space-y-3`

---

## 4. Border Radii

| Tailwind | Approx px | Usage |
|---|---|---|
| `rounded` | 4px | Palette items, inline buttons, tags |
| `rounded-sm` | 2px | Select items |
| `rounded-xs` | 1px | Resizable handle grip |
| `rounded-md` | 6px | Nodes, inputs, buttons, select triggers |
| `rounded-lg` | 8px | Properties panel sections |
| `rounded-full` | 50% | Handles, slider track/thumb |
| `rounded-t-md` | 6px top-only | Node header |

shadcn radius system (`--radius: 0.625rem` → sm/md/lg/xl/2xl/3xl) is defined but **not used** by custom components.

---

## 5. Shadows

| Tailwind | Usage |
|---|---|
| `shadow-xs` | Input, select trigger |
| `shadow-sm` | Slider thumb |
| `shadow-md` | Select dropdown |
| `shadow-lg` | Selected nodes (via React Flow CSS) |
| Custom box-shadow | `0 0 0 2px var(--indigo)` on selected nodes (index.css) |

---

## 6. Transitions

| Value | Usage |
|---|---|
| `transition` | Handle state change |
| `transition-all` | Button hover/focus |
| `transition-colors` | Palette item hover |
| `transition-[color,box-shadow]` | Input focus, slider thumb, select |

---

## 7. Component Inventory

### 7A. shadcn/ui Primitives (`src/components/ui/`)

| Component | File | Variants/Notes |
|---|---|---|
| **Button** | button.tsx | 6 variants × 8 sizes (incl. icon sizes) |
| **Input** | input.tsx | Single variant, h-9 default |
| **Slider** | slider.tsx | Horizontal/vertical, Radix-based |
| **Select** | select.tsx | Compound: Trigger, Content, Item, Label, Separator, Scroll buttons |
| **Label** | label.tsx | Accessible label with disabled states |
| **Separator** | separator.tsx | Horizontal/vertical divider |
| **Resizable** | resizable.tsx | PanelGroup + Panel + Handle, patched for v4 API |

### 7B. Custom Components (`src/components/`)

| Component | File | Subcomponents | Description |
|---|---|---|---|
| **BaseNode** | base-node.tsx | Header, HeaderTitle, Content, Footer | Node card wrapper with selection styling |
| **BaseHandle** | base-handle.tsx | — | React Flow handle with color + connected/hollow state |
| **LabeledHandle** | labeled-handle.tsx | — | Handle + text label, position-aware layout |
| **ShaderNode** | ShaderNode.tsx | — | Full node renderer (handles, params, connectable params, ±buttons) |
| **TypedEdge** | TypedEdge.tsx | — | Color-coded bezier edge based on port type |
| **FlowCanvas** | FlowCanvas.tsx | — | React Flow canvas with DnD, reconnection, validation |
| **NodePalette** | NodePalette.tsx | — | Categorized draggable node list |
| **PropertiesPanel** | PropertiesPanel.tsx | — | Selected node detail/edit view |
| **NodeParameters** | NodeParameters.tsx | FloatSlider, ColorInput, EnumSelect | Parameter control renderers |
| **ZoomSlider** | zoom-slider.tsx | — | Zoom control (slider + buttons + fit-view) |

### 7C. Layout Structure (`App.tsx`)

```
App (h-screen w-screen grid)
└── ResizablePanelGroup (horizontal)
    ├── Panel "palette" (18%, min 12%, max 30%)
    │   └── NodePalette
    ├── Panel "center" (64%)
    │   └── ResizablePanelGroup (vertical)
    │       ├── Panel "canvas" (70%, min 30%)
    │       │   └── FlowCanvas (ReactFlow)
    │       └── Panel "preview" (30%, min 10%)
    │           └── <canvas> (WebGL)
    └── Panel "properties" (18%, min 12%, max 30%)
        └── PropertiesPanel
```

---

## 8. Icons

Using **Lucide React** (5 icons total):
- `Maximize` — Fit-to-view (zoom-slider)
- `Minus` / `Plus` — Zoom in/out (zoom-slider)
- `GripVerticalIcon` — Resizable panel handle
- `CheckIcon` — Select item indicator
- `ChevronDownIcon` / `ChevronUpIcon` — Select trigger/scroll

---

## 9. Issues & Inconsistencies

### Critical (should fix in code before/during Figma build)
1. **Duplicated port color map** — `getPortColor()` in ShaderNode.tsx and `PORT_COLORS` in TypedEdge.tsx are identical maps defined separately. Should be a single shared constant.
2. **Duplicated `resolveSourceFloat()`** — Identical function in both ShaderNode.tsx and PropertiesPanel.tsx.

### ~~Dual Color Systems~~ (Resolved — Sprint 5.75)
3. ~~**Two parallel token systems**~~ → Sombra tokens unified and registered with Tailwind. shadcn tokens kept separate by design.
4. ~~**Different application methods**~~ → Inline `style={{}}` migrated to Tailwind utility classes (48 occurrences across 8 files).
5. ~~**No light theme**~~ → Light mode values defined in Figma variable spec; implementation deferred until Figma variables are built.

### Color Inconsistencies
6. **Inconsistent default port color** — `#6b7280` (gray-500) in base-handle/TypedEdge vs `#9ca3af` (gray-400) in ShaderNode's fallback.
7. **Untokenized colors** — `#000` for preview bg, `bg-red-900`/`border-red-700` for error state, `rgba(15,15,26,0.85)` for minimap mask.

### Typography
8. **Mixed letter-spacing** — `tracking-wider` vs `tracking-wide` for similar category headers.
9. **Arbitrary font sizes** — Heavy use of `text-[10px]` and `text-[11px]` (not in Tailwind scale).
10. **No defined type scale** — Font sizes chosen ad-hoc per component.

### Spacing & Radii
11. **No spacing scale** — All spacing is arbitrary Tailwind utilities.
12. **Inconsistent radii** — `rounded`, `rounded-md`, `rounded-lg` across similar contexts without clear hierarchy.
13. **Unused shadcn radius system** — `--radius` and derived vars are defined but custom components don't use them.

### Structural
14. ~~**Inline styles everywhere**~~ → Resolved in Sprint 5.75 (48 migrated to Tailwind classes).
15. **No component documentation** — No Storybook, no usage examples, no prop docs beyond TypeScript types.
