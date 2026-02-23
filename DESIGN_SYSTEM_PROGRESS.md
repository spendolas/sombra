# Sombra Design System — Progress Tracker

## Current Phase
**Phase 2: Figma Recreation** — ✅ Complete (Design system built + finalized + expanded via Plugin API)

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
- [x] **Phase 2:** Set up page structure (Archive — Captures, Foundations, Atoms, Molecules, Organisms, Templates)
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

### 2026-02-23 (Random Node Refactor — Stable Seed + Decimals + Semantic Recompilation)
- **Random node refactored:** Replaced `u_random` uniform with stored `seed` hidden param. Value is now deterministic and stable — only changes on explicit Randomise click.
- **New `decimals` param:** Controls output precision (0 = integer, 7 = full float). GLSL rounds via `floor(raw / step + 0.5) * step`.
- **RandomDisplay custom component:** `src/components/RandomDisplay.tsx` — shows computed value (matching GLSL rounding) + Shuffle icon Randomise button. Auto-initializes seed on first render.
- **Exported `hashNodeId`:** Now importable from `src/nodes/input/random.ts` for use by both GLSL generator and RandomDisplay.
- **Removed `u_random` infrastructure:** Removed `randomValue` field + `Math.random()` from `renderer.ts`, removed `u_random` uniform declaration from `glsl-generator.ts`.
- **Semantic recompilation key:** `use-live-compiler.ts` now derives a `semanticKey` from node data + edges only (skips selection, position, measured state). Eliminates wasteful recompilation on select/deselect/drag.
- **Figma:** Random template (80:733) updated: added Separator, Float Slider "Decimals" (value: 7), Random Display frame (mono value text + Randomise button). All colors variable-bound, button size/radius bound to Sizes/Radius collections.

### 2026-02-22 (Seed System + Random Node + DS Updates)
- **UV Coordinates → UV Transform:** Renamed node type (`uv_coords` → `uv_transform`), added `coords` input with `default: 'auto_uv'` (dual-purpose: source when unconnected, transformer when wired)
- **Seed param on noise nodes:** Added `seed` float param (default: 12345, connectable) to Noise, FBM, and Domain Warp. GLSL derives vec2 offset from seed for pattern variation.
- **Domain Warp `warpedPhase` output:** New float output for spatially-varying phase (3rd warp channel, z-displacement)
- **Random Number node:** New `src/nodes/input/random.ts` — per-instance node ID hash + `u_random` uniform, connectable min/max params
- **`u_random` uniform:** Added to `renderer.ts` (Math.random() per recompile) and `glsl-generator.ts` declaration
- **Quantize UV simplified:** Stripped `scale`, `seedX`, `seedY` params — now only `pixelSize`. Single-purpose: snap to pixel grid.
- **Presets 3 & 4 rewired:** Added UV Transform nodes for scale/offset instead of Quantize UV params
- **Node count:** 23 → 24 (Random added, UV Coordinates renamed to UV Transform, Quantize UV simplified)
- **Figma:**
  - Templates: UV Transform (renamed + Coords input), Noise/FBM/Domain Warp (Seed param row), Random (new), Quantize UV (new, pixelSize only), Domain Warp (Warped Phase output)
  - Node Palette: 22 → 24 items (Random + Quantize UV added, UV Coordinates → UV Transform)
  - Updated `.figma/design-system.md` template list and palette count
  - Updated `NODE_AUTHORING_GUIDE.md` node inventory

### 2026-02-22 (Visual Parity Fix — Value FBM)
- **Pixel Grid:** Removed `coords` input, now uses `gl_FragCoord.xy` directly for square screen-space pixels
- **Bayer Dither:** Removed `coords` input, now uses `gl_FragCoord.xy` directly
- **New node:** `quantize_uv` (Quantize UV) — snaps coordinates to pixel-grid cell centers via `gl_FragCoord.xy`, outputs frozen-ref UV. Connectable `pixelSize` param (2-64, default 8). Wire to noise `coords` for uniform color per cell.
- **Node count:** 22 → 23
- Updated spectra Value FBM test preset to wire Quantize UV → Noise.coords for per-cell sampling
- **Figma:** Pixel Grid template needs Coords handle removed; Bayer Dither template needs Coords handle removed; new Quantize UV template needed

### 2026-02-21 (Sprint 7 — Pixel Rendering)
- **Code implementation:** Created new `Post-process` category with 2 nodes:
  - `src/nodes/postprocess/pixel-grid.ts` — Pixel Grid node: color (vec3) + coords (vec2) inputs, result (vec3) output, connectable pixelSize/dither params, shape enum (circle/diamond/triangle), shared Bayer 8×8 dithering + shape SDF functions via `addFunction()`
  - `src/nodes/postprocess/bayer-dither.ts` — Bayer Dither node: coords (vec2) input, threshold (float) output, scale param, shared `bayer8x8` function via `addFunction()`
- Registered both in `src/nodes/index.ts` — new Post-process section in `ALL_NODES`
- **Node count:** 20 → 22
- Updated `NODE_AUTHORING_GUIDE.md` Node Inventory table and file organization
- **Figma templates:** Created Pixel Grid (`72:627`) and Bayer Dither (`72:668`) on Templates page in new POST-PROCESS column
- **Node Palette:** Added POST-PROCESS category group (`72:695`) with 2 Palette Item instances (Pixel Grid `72:698`, Bayer Dither `72:700`), between NOISE and OUTPUT
- **Updated `.figma/design-system.md`:** Templates 22→24, Palette 20→22 items, 5→6 categories

### 2026-02-21 (Sprint 6 — Color Ramp Node)
- **Created Gradient Editor molecule** (`50:4208`) on Molecules page — vertical auto-layout component with:
  - Gradient Bar (FILL × 24px, radius/md, edge/default stroke, linear gradient placeholder)
  - Stop Markers Row (FILL × 16px, absolute child ellipses 12×12 bound to sizes/handle)
  - Controls Row (horizontal auto-layout, spacing/xs gap: color swatch + position text + add/remove buttons)
  - Preset Selector (Enum Select molecule instance)
  - All fills/strokes bound to UI Colors variables, spacing bound to Spacing variables, dimensions bound to Sizes variables
- **Created Color Ramp node template** (`50:4226`) on Templates page — 160×302px, COLOR column:
  - Header ("Color Ramp") + Content (vec3 output "Color", float input "Value", Separator, Enum "Interpolation: smooth", Gradient Editor instance)
- **Added "Color Ramp" Palette Item** (`50:4260`) to Node Palette COLOR group (20th item total)
- **Code implementation:** `src/nodes/color/color-ramp.ts` (node definition + GLSL generator), `src/components/ColorRampEditor.tsx` (interactive gradient editor with 6 presets), registered in `src/nodes/index.ts`
- **Node count:** 19 → 20, **Molecule count:** 11 → 12, **Template count:** 21 → 22
- Updated `.figma/design-system.md` with new component IDs and Code Connect mappings
- Updated `NODE_AUTHORING_GUIDE.md` Node Inventory table

### 2026-02-21 (Session 8 — Fidelity Fix Pass)
- **Fixed Node Card header** (`40:649`): Added `bg-surface-raised` fill, `border-b border-edge-subtle` bottom stroke, `rounded-t-md` top corners (6px), `gap-2` itemSpacing (was 0). Applied to both selected/unselected variants.
- **Fixed Node Card content** spacing: `itemSpacing: 0` → `8` (matches code `gap-y-2`). Applied to both variants.
- **Fixed PlusMinus Button** (`17:258`): Height 17px → 20px (matches code `h-5`). All 4 variants now 20×20.
- **Applied text overrides to all 19 node templates** (95 total text overrides):
  - Replaced all generic "Label" text on Labeled Handle instances with actual port names (Value, Coords, Phase, Fn, A, B, C, etc.)
  - Replaced all generic "Scale" text on Connectable Param Rows with actual param names (Scale, Octaves, Lacunarity, Gain, Frequency, Amplitude, Factor, Brightness, Contrast, etc.)
  - Replaced all generic "Noise Type"/"simplex" on Enum Selects with correct enum labels (Operation/add, Function/sin, Fractal Mode/standard, etc.)
  - Replaced all generic slider labels/values with correct defaults (Value/1.00, X/0.00, Y/0.00, etc.)
- **Fixed Default Graph scene template** (`40:17910`): Time, Noise, Fragment Output nodes now show correct port/param labels.
- **Verified all atom/molecule sizes** against codebase: Handle 12×12 ✓, Float Slider itemSpacing 6 + fontSize 10 ✓, Enum Select trigger h=28 ✓, Color Input swatch h=24 ✓, Dynamic Input Controls gap=8 ✓.

### 2026-02-21 (Session 7 — DS Cleanup & Expansion)
- **Fixed Node Palette width** (`39:289`): 77px → 200px (counterAxisSizingMode=FIXED, minWidth=200). All text now visible.
- **Fixed Labeled Handle alignment** (`37:181`): Label `layoutSizingHorizontal` set to FILL on all 16 variants. Right-position labels push text rightward; left-position labels fill available space.
- **Fixed Connectable Param Row slider labels**: "Phase" slider was showing "Scale" — corrected in both Node Card variants.
- **Fixed category headers** in Node Palette: 5 headers changed from HUG to FILL sizing.
- **Created 2 new atoms:** Preview Badge (`40:390`), Grid Dot (`40:392`) — both variable-bound.
- **Created 3 new molecules:** Dynamic Input Controls (`40:393`, nests 2× PlusMinus Button), Typed Edge (`40:432`, 8 variants bound to Port Types vars), MiniMap (`40:433`, surface/alt 85% + indigo indicators).
- **Rebuilt Node Card** (`40:649`, was `39:288`): Flexible COMPONENT_SET with **19 boolean + 1 text + 1 variant** properties. Boolean slots control visibility of Output 1-2, Input 1-5, Dynamic Buttons, Connectable 1-5, Param Separator, Enum 1-2, Slider 1-2, Color Picker. Default: all ON. Min-width: 160px (matches code).
- **Created all 19 node templates** on Templates page (5-column grid by category):
  - INPUT (6): Number, Color, Vec2, UV Coordinates, Time, Resolution
  - MATH (7): Arithmetic, Trig, Mix, Smoothstep, Remap, Turbulence, Ridged
  - NOISE (3): Noise, FBM, Domain Warp
  - COLOR (2): HSV to RGB, Brightness/Contrast
  - OUTPUT (1): Fragment Output
- **Created Default Graph scene template**: Time → Noise → Fragment Output with Typed Edge wires.
- **Created Sombra App scene template** (1440×900): 3-panel layout with Node Palette, Canvas (Grid Dots + Zoom Bar + MiniMap), Preview (Preview Badge), Properties Panel.
- **Page layout cleanup**: All pages re-arranged with section labels (SIMPLE ATOMS / VARIANT SETS, HANDLE MOLECULES / PARAMETER CONTROLS / PANEL MOLECULES / CANVAS ELEMENTS, NODE CARD / NODE PALETTE / PROPERTIES PANEL). Proper spacing accounting for variant set dimensions.
- **Removed orphans/duplicates**: Duplicate Preview Badge, orphaned portType components, stray build artifacts.
- **Cross-referenced sizes** against codebase: Node Card min-width=160px, header padding=12/8px, content padding=12px (all match `ShaderNode.tsx` / `base-node.tsx`).
- **Final count:** 22 components (8 atoms + 11 molecules + 3 organisms) + 21 template items
- Updated `.figma/design-system.md` with new component IDs, flexible Node Card spec, full template list.
- Updated Code Connect mappings: Node Card ID `39:288` → `40:649`.

### 2026-02-21 (Session 6 — Atomic Hierarchy Rebuild)
- **Restructured entire Figma design system** from flat pages to atomic design methodology
- **Created 4 new pages:** Atoms, Molecules, Organisms, Templates (replacing Primitives, Components, Compositions, App Layout)
- **Created 3 new atom components:** Category Header (`37:96`), Port Type Badge (`37:131`, 8 variants), Separator (`37:132`)
- **Moved 3 existing atoms** to Atoms page: Handle (`17:161`), Palette Item (`17:248`), PlusMinus Button (`17:258`)
- **Rebuilt Labeled Handle** (`37:181`) with nested `Atoms/Handle` instance (was raw ellipse) — 16 variants
- **Created Connectable Param Row** (`37:200`) with nested Handle + Float Slider instances — 2 variants
- **Rebuilt Properties Info Card** (`37:201`) with nested Category Header instance
- **Rebuilt Properties Port Row** (`37:206`) with nested Port Type Badge instance
- **Moved 4 molecules** to Molecules page: Float Slider, Enum Select, Color Input, Zoom Bar
- **Built Node Card organism** (`39:288`) with nested Labeled Handle ×3, Connectable Param Row ×2, Enum Select, Separator ×2 — 2 variants
- **Built Node Palette organism** (`39:289`) with Category Header ×5, Palette Item ×19, Separator ×4
- **Built Properties Panel organism** (`39:393`) with Category Header ×4, Info Card, Port Row ×4, Float Slider, Enum Select — 2 variants
- **Built 6 template frames:** Noise Node, Arithmetic Node, Fragment Output, Node Palette, Properties Panel, Sombra App (1440×900 3-panel)
- **Deleted 4 old pages:** Primitives, Components, Compositions, App Layout (content migrated/rebuilt)
- **Cascade chain verified:** Atom changes propagate through Molecules → Organisms → Templates automatically
- **Final count:** 17 components (6 atoms + 8 molecules + 3 organisms) + 6 template frames
- Updated `.figma/design-system.md` with atomic hierarchy, new node IDs, cascade chain documentation
- Updated Code Connect mappings table with new component IDs organized by atomic level

### 2026-02-21 (Session 5 — Deep Audit)
- **Full audit** of Figma design system: 33 checks across 9 phases
- **Results:** 27 PASS, 4 FAIL (fixed), 1 WARN (P2, noted), 1 P2 cosmetic
- **Fixes applied via Plugin API:**
  - Body text style: 13px → 14px (was matching React Flow base size, should match `text-sm` spec)
  - Node Palette label: "Color Picker" → "Color" (matches `src/nodes/input/color-constant.ts`)
  - Node Palette label: "Float Constant" → "Number" (matches `src/nodes/input/float-constant.ts`)
  - Node Palette label: "Vec2 Constant" → "Vec2" (matches `src/nodes/input/vec2-constant.ts`)
  - Arithmetic enum text: "simplex" → "add" (correct default operation)
  - Foundations typography specimen label auto-updated to "Body — Inter 14px"
- **Noted (P2, no fix):** Handle component is 12×12px (spec says 11×11px) — cosmetic only
- **Validated:** 4 variable collections (31 vars, all hex values correct), 10 text styles, 12 components (correct types/IDs/variants), Foundations page bindings (swatches, spacing bars, radius samples, typography), 5 compositions (correct instance counts and component sources), App Layout (1440×900, 3 panels, 8 instances)

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
