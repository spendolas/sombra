# Sombra Roadmap

## Phase 0 — Scaffold & Proof of Concept ✅ COMPLETE

**Goal:** An empty React Flow canvas you can pan around, with a colored fullscreen WebGL quad rendering beside it. Deploys to GitHub Pages.

- [x] Vite + React + TypeScript scaffold
- [x] Install and configure: `@xyflow/react`, `zustand`, `tailwindcss`
- [x] `vite.config.ts` with `base: '/sombra/'`
- [x] Basic `App.tsx` with React Flow canvas (Background, Controls, MiniMap)
- [x] Dark theme base styles (`#0a0a12` background)
- [x] **Fullscreen WebGL quad renderer** — a raw WebGL2 canvas that renders a simple passthrough fragment shader (solid color or gradient). Proves the WebGL pipeline works before connecting it to the node graph. Renders beside or behind the React Flow canvas.
- [x] **Layout shell** — node canvas (center), placeholder for properties panel (right), placeholder for node palette (left)
- [x] **GitHub Pages deploy** — GitHub Actions workflow that builds and pushes `dist/` to `gh-pages` branch
- [x] Write `CLAUDE.md` (project instructions for future sessions)
- [x] Write `ROADMAP.md` (this roadmap, standalone file in the repo)
- [x] Git init, initial commit, push to `spendolas/sombra`

**Milestone:** Pan around an empty canvas. A colored WebGL quad renders. Site is live at `spendolas.github.io/sombra`.

---

## Phase 1 — Core Editor MVP ✅ COMPLETE

**Goal:** Drag UV Coords -> Noise -> Mix -> Fragment Output, tweak parameters, see live animated noise fullscreen. This is the "it works" moment.

**Status:** ✅ Delivered February 2026

### Node System Architecture

```typescript
interface NodeDefinition {
  type: string;              // e.g. "simplex_noise"
  label: string;             // e.g. "Simplex Noise"
  category: string;          // e.g. "Noise"
  inputs: PortDefinition[];  // typed input ports
  outputs: PortDefinition[]; // typed output ports
  defaults: Record<string, any>;
  glsl: (inputs, outputs, params) => string;  // GLSL code generator
  ui?: React.ComponentType;  // optional custom node body
}

// Port types: float, vec2, vec3, vec4, color, sampler2D
// Auto-coercion: float -> vec3 broadcasts, vec4 -> vec3 drops alpha, etc.
```

### Starter Node Library (~15 nodes)

| Category | Nodes |
|---|---|
| **Input** | UV Coordinates, Time, Resolution, Float Constant, Vec2 Constant, Color Picker |
| **Math** | Add, Multiply, Mix (lerp), Smoothstep, Sin/Cos, Remap |
| **Noise** | Simple Noise (value), Simplex Noise |
| **Color** | HSV to RGB, Brightness/Contrast |
| **Output** | Fragment Output (master node — always exactly one) |

### Graph-to-GLSL Compiler

1. Topological sort from Fragment Output backward
2. Each node emits GLSL with unique variable names (`node_<id>_out`)
3. Unconnected inputs use default values
4. Auto type conversion at mismatched connections
5. Assemble complete fragment shader: uniforms + main() + node snippets
6. Built-in uniforms: `u_time`, `u_resolution`, `u_mouse`
7. Error handling: parse WebGL shader compile log, map errors back to offending nodes

### Delivered Features

- [x] 16-node library (Input, Math, Noise, Color, Output categories)
- [x] Node palette with drag-and-drop
- [x] Type-safe port connections with visual validation
- [x] Automatic type coercion (15+ conversion rules)
- [x] Parameter controls (sliders with text input, color pickers)
- [x] Properties panel for node inspection
- [x] Graph-to-GLSL compiler with error mapping
- [x] Live animated simplex noise working correctly
- [x] Dark theme with accessible color palette
- [x] Complete reactive pipeline (edit → validate → compile → render)

**Milestone:** ✅ Wire nodes together, tweak parameters with inline controls, see live animated output.

---

## Phase 1.2 — UI Polish & Resizable Layout ✅ COMPLETE

**Goal:** Replace the rigid CSS Grid layout with a professional resizable panel UI, integrate shadcn/ui components, and fix the preview resize-zoom issue.

**Status:** ✅ Delivered February 2026

### Delivered Features

- [x] shadcn/ui integration (Button, Input, Label, Slider, ScrollArea, Separator)
- [x] React Flow UI components (BaseNode, LabeledHandle, ZoomSlider)
- [x] Resizable three-panel layout (react-resizable-panels v4)
- [x] Header removed — full-height panels for maximum workspace
- [x] ShaderNode restyled with BaseNode/LabeledHandle
- [x] Frozen-reference preview (`u_ref_size` uniform) — resizing reveals/hides edges without zoom or distortion
- [x] Preview canvas fills entire panel (no black bars, no aspect-ratio lock)
- [x] Patched shadcn resizable.tsx for react-resizable-panels v4 API

### Technical Details

- `u_ref_size`: freezes `min(canvas.width, canvas.height)` on first render as a float uniform
- UV node: `(v_uv - 0.5) * u_resolution / u_ref_size + 0.5` — each axis scales independently
- Resizing only changes visible range, center stays at UV (0.5, 0.5), circles stay circular
- react-resizable-panels v4 uses `orientation` (not `direction`), string sizes like `"18%"` (not numbers)

**Milestone:** ✅ Professional resizable layout, polished node appearance, zoom-free preview on resize.

---

## Phase 2 — Spectra Mode + UX Polish ✅ COMPLETE

**Goal:** Replicate the full spectra-pixel-bg noise/color/pixel experience as composable node-graph features, and polish the connection UX. When complete, all four spectra presets (Value FBM, Simplex FBM, Worley Ridged, Box None) can be recreated as node graphs, plus novel combinations that spectra-pixel-bg could never express.

**Status:** ✅ Delivered February 2026 — 22 nodes across 6 categories (Input, Math, Noise, Color, Post-process, Output)

**Reference:** spectra-pixel-bg `fork` branch (4 noise types, 4 fractal modes, domain warp, 7-color palette with 3 blend modes, pixel dithering with shape SDFs).

### Sprint 1 — Infrastructure + UX Polish ✅ Complete

#### A. Compiler Improvements ✅

- [x] `functionRegistry: Map<string, string>` on `GLSLContext` with `addFunction(ctx, key, code)` helper
- [x] Simplex noise migrated to shared functions (no more per-instance duplication)
- [x] `'enum'` parameter type with `options` field, rendered via shadcn `<Select>`

#### B. Connection UX Polish ✅

- [x] `TypedEdge` component — edges colored by source port type (`EdgeData.sourcePortType`)
- [x] Handle colors: `BaseHandle` takes `handleColor` + `connected` props (filled=connected, hollow=unconnected)
- [x] `connectionRadius={20}`, reconnectable edges (`onReconnect` handlers), delete-on-drop, single-wire-per-input swap

### Sprint 2 — Noise Primitives ✅ Complete

All noise nodes share the same interface: `coords` (vec2, `auto_uv` default) + `phase` (float, for time animation — was `z`, renamed Sprint 5.5) + `scale` (float) → `value` (float, 0-1).

- [x] **Simplex Noise 3D** — Upgraded to 3D with `z` input (`src/nodes/noise/simplex-noise.ts`)
- [x] **Value Noise 3D** — Hash-based 3D noise (`src/nodes/noise/value-noise.ts`)
- [x] **Worley Noise** — Cellular/Voronoi distance field (`src/nodes/noise/worley-noise.ts`)
- [x] **Box Noise** — Quantized value noise with `boxFreq` (`src/nodes/noise/box-noise.ts`)

### Sprint 3 — Fractal & Warp Layer ✅ Complete

- [x] **FBM** — Multi-octave fractal accumulator with `noiseType` enum + `fractalMode` enum (`src/nodes/noise/fbm.ts`)
- [x] **Turbulence** — Standalone remap: `abs(n * 2.0 - 1.0)` (`src/nodes/noise/turbulence.ts`)
- [x] **Ridged** — Standalone remap: `(1.0 - abs(n * 2.0 - 1.0))^2` (`src/nodes/noise/ridged.ts`)
- [x] **Domain Warp** — Coordinate distortion using value noise (`src/nodes/noise/domain-warp.ts`)

### Sprint 4 — Unified Noise Node + Cleanup ✅ Complete

**Goal:** Consolidate 4 separate noise nodes into 1 unified Noise node (Redshift-style), and move Turbulence/Ridged to Math.

#### Unified Noise Node

Replace `simplex-noise.ts`, `value-noise.ts`, `worley-noise.ts`, `box-noise.ts` with a single `noise.ts`. One node with a `noiseType` dropdown (simplex/value/worley/box). Changing noise type = dropdown change, no rewiring.

- [x] Create `src/nodes/noise/noise.ts` — unified noise node with type enum
- [x] Delete 4 old files: `simplex-noise.ts`, `value-noise.ts`, `worley-noise.ts`, `box-noise.ts`

#### FBM — noiseType enum

FBM has its own `noiseType` enum + `fractalMode` enum (standard/turbulence/ridged).

- [x] Revise `src/nodes/noise/fbm.ts`

#### Domain Warp — noiseType enum

Domain Warp has its own `noiseType` enum for selecting noise function.

- [x] Revise `src/nodes/noise/domain-warp.ts`

#### Move Turbulence & Ridged to Math

These are general-purpose signal remaps (`float → float`), not noise-specific.

- [x] Move `src/nodes/noise/turbulence.ts` → `src/nodes/math/turbulence.ts`, change `category: 'Math'`
- [x] Move `src/nodes/noise/ridged.ts` → `src/nodes/math/ridged.ts`, change `category: 'Math'`

#### Other

- [x] Update `src/nodes/index.ts` — replace 4 noise imports with 1, update turbulence/ridged paths
- [x] Right-align output port labels (`labeled-handle.tsx`)
- [x] `NodeParameter.showWhen` — conditional param visibility (boxFreq only shown when noiseType=box)

### Sprint 4.5 — Connectable Parameters (UX Refactor) ✅ Complete

**Goal:** Unify the handle and slider systems so every float parameter can optionally be wired, with inline rendering and proper locked state when connected.

**Solution:** `connectable?: boolean` flag on `NodeParameter`. Connectable params render as inline handle+slider rows. When wired, the slider dims and the compiler uses the wired GLSL variable. When not wired, the compiler reads the slider value from `node.data.params`.

#### Type System
- [x] Add `connectable?: boolean` to `NodeParameter` in `src/nodes/types.ts`

#### Compiler
- [x] Fix unconnected-input fallback in `src/compiler/glsl-generator.ts` — use `node.data.params[id]` for connectable params instead of port default
- [x] `formatDefaultValue` outputs proper GLSL float literals (integers get `.0` suffix)

#### UI Components
- [x] Export `FloatSlider` from `src/components/NodeParameters.tsx`
- [x] Connectable param rows in `ShaderNode.tsx` — `BaseHandle` + inline `FloatSlider`, dimmed when wired
- [x] Rework `ShaderNode.tsx` layout — partition into pure inputs → connectable param rows → outputs → regular params
- [x] `isValidConnection` in `FlowCanvas.tsx` checks connectable params as valid targets

#### Node Definitions
- [x] `noise.ts` — `connectable: true` on scale, GLSL uses `inputs.scale` directly
- [x] `fbm.ts` — `connectable: true` on scale/lacunarity/gain, GLSL passes lac/gain as function args
- [x] `domain-warp.ts` — `connectable: true` on strength/frequency, GLSL uses `inputs.strength`/`inputs.frequency`
- [x] `mix.ts` — `connectable: true` on factor, GLSL uses `inputs.factor`
- [x] `brightness-contrast.ts` — `connectable: true` on brightness/contrast, GLSL uses `inputs.brightness`/`inputs.contrast`

### Sprint 4.75 — Math Node Consolidation + UX Polish ✅ Complete

#### Math Nodes
- [x] Unified **Arithmetic** node — replaces Add + Multiply, adds Subtract + Divide. Enum dropdown for operation, dynamic 2-8 inputs via +/- buttons (`src/nodes/math/arithmetic.ts`)
- [x] Unified **Trig** node — replaces Sin + Cos, adds Tan + Abs. Enum dropdown, connectable frequency/amplitude (`src/nodes/math/trig.ts`)
- [x] Delete `add.ts`, `multiply.ts`, `sin.ts`, `cos.ts`
- [x] Update `src/nodes/index.ts` — replace 4 imports with 2

#### Infrastructure
- [x] `dynamicInputs?: (params) => PortDefinition[]` on `NodeDefinition` in `types.ts`
- [x] `hidden?: boolean` on `NodeParameter` in `types.ts`
- [x] Compiler (`glsl-generator.ts`): use `dynamicInputs(params)` when available
- [x] `FlowCanvas.tsx`: use `dynamicInputs(params)` in `isValidConnection`

#### UX Polish
- [x] `ShaderNode.tsx`: outputs above inputs, category label removed from header
- [x] `ShaderNode.tsx`: +/- button UI for dynamic input nodes, edge cleanup on port removal
- [x] Source value resolution: connected params show actual source value (float_constant → slider at value) or "← SourceLabel" (dynamic sources)
- [x] `NodeParameters.tsx`: `SourceInfo` type, `connectedSources` prop, `FloatSlider` disabled state with resolved values
- [x] `PropertiesPanel.tsx`: read edges + nodes from store, build `connectedSources` map, pass to `NodeParameters`

#### Additional Connectable Params
- [x] `noise.ts`: `boxFreq` now connectable, GLSL uses `inputs.boxFreq`
- [x] `fbm.ts`: `octaves` now connectable — max-bound loop (8) with `if (float(i) >= oct) break;` for runtime octaves

### Sprint 5 — UV Transform + Vec2 Constant ✅ Complete

Redshift-style: transform controls on the coordinate source node itself, not separate nodes.

- [x] **UV Coordinates** — extended with 5 connectable SRT params: `scaleX`, `scaleY`, `rotate`, `offsetX`, `offsetY`. GLSL: center → scale(non-uniform) → rotate(2D matrix) → offset + re-center. Identity defaults = zero breaking change. (`src/nodes/input/uv-coords.ts`)
- [x] **Vec2 Constant** — static vec2 output with X/Y sliders (`src/nodes/input/vec2-constant.ts`)
- [x] Updated `src/nodes/index.ts` — added Vec2 Constant import

### Sprint 5.5 — Auto UV Default + Phase Rename ✅ Complete

Noise nodes produce visible patterns out of the box without wiring UV Coordinates. The `z` input was renamed to `phase`.

- [x] **Compiler `auto_uv` sentinel** — when a `vec2` input has `default: 'auto_uv'` and is unconnected, compiler generates frozen-ref UV inline. `sanitizedNodeId` moved earlier, `preambleLines` array emitted before node GLSL. (`src/compiler/glsl-generator.ts`)
- [x] **Noise node `coords` default** — changed from `[0.0, 0.0]` to `'auto_uv'` on all 3 noise nodes (`noise.ts`, `fbm.ts`, `domain-warp.ts`)
- [x] **Rename `z` → `phase`** — port id, label, and all GLSL template references across all 3 noise nodes + test graph (`test-graph.ts`)
- [x] **Default test graph simplified** — removed UV Coordinates node (auto_uv makes it unnecessary)

### Sprint 6 — Color Ramp (1 node, biggest single item) ✅ Complete

General-purpose multi-stop gradient mapper: float (0-1) → color (vec3). This is the scalable replacement for spectra's fixed 7-color palette system — arbitrary number of stops, usable by any future node library.

- [x] **Color Ramp node** — GLSL: chain of `mix()` + `smoothstep()` for linear/smooth, `step()` for constant interpolation (`src/nodes/color/color-ramp.ts`)
- [x] **ColorRampEditor component** — interactive gradient bar with draggable stops, per-stop color pickers, interpolation mode dropdown (`src/components/ColorRampEditor.tsx`)
- [x] **6 palette presets** — Cobalt Drift, Violet Ember, Teal Afterglow, Solar Ember, Citrus Pulse, Rose Heat (from spectra-pixel-bg)
- [x] Stops stored as `params.stops` (serializable array), UI via `component` field — no changes to `NodeParameter` type system needed

### Sprint 7 — Pixel Rendering (2 nodes) ✅ Complete

- [x] **Pixel Grid** — Post-processing node: quantization + Bayer 8x8 dithering + shape SDF (circle/triangle/diamond). Inputs: `color` (vec3), `coords` (vec2). Params: `pixelSize` (2-20), `shape` (enum), `dither` (0-1) (`src/nodes/postprocess/pixel-grid.ts`)
- [x] **Bayer Dither** — Standalone 8x8 Bayer dither pattern. Outputs threshold float for current pixel. Enables creative dithering beyond pixel art (`src/nodes/postprocess/bayer-dither.ts`)

### Node Summary (After Sprint 4)

| Node | Category | Notes |
|------|----------|-------|
| **Noise** | Noise | Unified: simplex/value/worley/box via dropdown |
| **FBM** | Noise | Revised: noiseType enum + fractalMode enum |
| **Domain Warp** | Noise | Revised: noiseType enum for noise selection |
| **Turbulence** | Math | Moved from Noise (general signal remap) |
| **Ridged** | Math | Moved from Noise (general signal remap) |
| UV Coordinates | Input | Sprint 5: extended with SRT transform params |
| Vec2 Constant | Input | Sprint 5 |
| Color Ramp | Color | Sprint 6 |
| Pixel Grid | Post-process | Sprint 7 |
| Bayer Dither | Post-process | Sprint 7 |

**After Sprint 4: 20 nodes** (4 separate noise → 1 unified = net -3). **After Sprint 4.5: still 20 nodes** (adds connectable param handles, no new nodes). **After Sprint 4.75: 18 nodes** (merged 4 math → 2 unified). **After Sprint 5: 19 nodes** (UV Coords extended, +1 Vec2 Constant). **After Sprint 5.5: 19 nodes** (compiler change + rename, no new nodes). **After Sprint 6: 20 nodes** (+1 Color Ramp). **After Sprint 7: 22 nodes** (+2 Pixel Grid, Bayer Dither). **Phase 2 complete: 22 nodes.**

### Auto-Layout Utility ✅ Complete

Dagre-based auto-layout for node positioning (`src/utils/layout.ts`, dependency: `@dagrejs/dagre`).

- **Two-pass layout:** dagre LR positioning + handle-order post-processing
- **Node size estimation:** derives width/height from `NodeDefinition` port counts (outputs, inputs, connectable params, regular params, custom component area)
- **Handle-order reorder:** siblings in the same dagre rank feeding the same target are vertically reordered to match the target's input handle order, eliminating wire crossings
- All 4 spectra presets and utility test graphs use `layoutGraph()` — manual positions are no longer needed

### Key Files

| File | Sprint 4 Changes |
|------|-----------------|
| `src/nodes/noise/noise.ts` | **New** — unified noise node (replaces 4 files) |
| `src/nodes/types.ts` | Updated with `showWhen`, conditional visibility |
| `src/compiler/glsl-generator.ts` | Updated for unified noise node |
| `src/nodes/noise/fbm.ts` | Revised with `noiseType` enum |
| `src/nodes/noise/domain-warp.ts` | Revised with `noiseType` enum |
| `src/nodes/math/turbulence.ts` | Moved from `noise/`, category → Math |
| `src/nodes/math/ridged.ts` | Moved from `noise/`, category → Math |
| `src/nodes/index.ts` | Replace 4 noise imports with 1, update turbulence/ridged paths |
| `src/components/ColorRampEditor.tsx` | Sprint 6 — gradient editor widget |

### Success Criteria

1. Unified Noise node with type dropdown (simplex/value/worley/box)
2. FBM has its own noiseType enum + fractalMode enum (standard/turbulence/ridged)
3. Domain Warp has its own noiseType enum for noise selection
4. Turbulence and Ridged nodes appear under Math category
5. Color Ramp maps float → color via interactive gradient editor with 6 spectra palette presets
6. Pixel Grid renders pixel art with circle/triangle/diamond shapes + Bayer dithering
7. UV nodes (rotate, scale, offset) enable spectra's `angle` and `flow` behaviors
8. **Acceptance test:** manually wire graphs that visually reproduce each of the 4 spectra presets
9. No regressions to live preview pipeline

**Milestone:** Composable noise→FBM node graph system that can recreate all spectra-pixel-bg effects.

---

## Dev Bridge — Browser Automation API ✅ COMPLETE

**Goal:** Expose Sombra's internals on `window.__sombra` so the Claude Chrome extension (or any browser automation / console tool) can programmatically create, wire, and manipulate nodes via JS injection.

**Status:** ✅ Delivered February 2026

### Delivered Features

- [x] `src/dev-bridge.ts` — installs `window.__sombra` at startup via `main.tsx`
- [x] High-level helpers: `createNode()`, `connect()`, `setParams()`, `moveNode()`, `removeNode()`, `clearGraph()`, `compile()`, `describeGraph()`, `describeNode()`, `listNodeTypes()`, `exportGraph()`, `importGraph()`, `getFragmentShader()`
- [x] Raw Zustand store access: `sombra.stores.graph`, `sombra.stores.compiler`, `sombra.stores.settings`
- [x] Node registry access: `sombra.registry`
- [x] Low-level compiler access: `sombra.compileGraph()`
- [x] Full API reference: `BROWSER-AUTOMATION.md`

**Milestone:** ✅ Build entire shader graphs from browser console or Chrome extension JS injection.

---

## Phase 3 — Save/Load/Share ✅ COMPLETE

**Status:** ✅ Delivered March 2026

- [x] localStorage auto-save with schema versioning (Zustand persist, `GRAPH_SCHEMA_VERSION`)
- [x] `.sombra` file download/upload for sharing graph files
- [x] Shareable viewer URLs — `viewer.html#graph=<compressed>` with full uniform/quality/animation support
- [x] Render Quality Tier — `quality` dropdown on Fragment Output (adaptive/low/medium/high), `updateMode: 'renderer'` bypasses recompilation
- [x] Random node viewer re-seeding — each viewer load produces unique output

### Delivered Features

- **`.sombra` file format** — versioned JSON envelope (`{ sombra: 1, nodes, edges }`), validates structure + node types on import
- **GraphToolbar** — floating pill at top-left of canvas with Download (save), FolderOpen (open), and Share icon buttons
- **`loadGraph()` store action** — undoable graph replacement (pushes previous state to undo stack)
- **Viewer page** — standalone page decodes compressed graph from URL hash, compiles, uploads uniforms, applies quality tier, conditionally animates
- **Render Quality Tier** — 4 tiers controlling FPS cap + DPR scale. Third update mode (`renderer`) bypasses shader recompilation and uniform uploads
- **Dev bridge updated** — `exportGraph()` returns versioned envelope, `importGraph()` accepts both versioned and bare formats
- New files: `src/utils/sombra-file.ts`, `src/components/GraphToolbar.tsx`, `src/viewer.ts`

**Milestone:** ✅ Save your work, share a viewer link, render at configurable quality.

---

## Phase 3.5 — Design System Migration ✅ COMPLETE

**Status:** Delivered March 2026

Expanded the DS database to capture ALL visual properties per component, eliminating inline Tailwind classes in favor of generated `ds.*` references.

- [x] Extended `ComponentPart` schema with 15 new fields: textStyle, textColor, cursor, transition, userSelect, position, z, overflow, opacity, inset, width, height, minWidth, pointerEvents + hover/active state objects
- [x] Updated `generate-tokens.ts` to emit all new fields as Tailwind utilities
- [x] Populated all 22 component parts in DB with full visual properties
- [x] Migrated 12+ component files to use `ds.*` references — zero inline visual classes for design properties
- [x] Created `figma-audit.ts` script — compares DB component parts against Figma REST API (layout, padding, gap, radius, fill, stroke, text style, text color)
- [x] Added `npm run tokens:audit` command
- [x] All components verified: `npm run build` + `npm run tokens:check`

**Key files:** `scripts/generate-tokens.ts`, `scripts/figma-audit.ts`, `tokens/sombra.ds.json`, `src/generated/ds.ts`

**Milestone:** Every visual class on every component is tracked in the DB and generated — single source of truth for design tokens AND component styles.

---

## Phase 4 — Node Library Expansion ✅ Complete

**Goal:** Grow from 23 to ~39 nodes with patterns, vector operations, coordinate transforms, math utilities, and color tools. Add Cmd+K search palette for discoverability.

### Sprint 1 — Pattern Generators (4 nodes, new `Pattern` category) ✅ Complete
- [x] Checkerboard — coords + scale → float (XOR grid pattern)
- [x] Stripes — coords + scale + angle + softness → float (rotated band pattern)
- [x] Dots — coords + scale + radius + softness → float (grid of circles)
- [x] Gradient — coords + type enum (linear/radial/angular/diamond) → float

### Sprint 2 — Vector Operations (4 nodes, new `Vector` category) ✅ Complete
- [x] Split Vec3 — vec3 → x, y, z floats (swizzle)
- [x] Combine Vec3 — x, y, z floats → vec3
- [x] Split Vec2 — vec2 → x, y floats (swizzle)
- [x] Combine Vec2 — x, y floats → vec2

### Sprint 3 — Coordinate Transforms (2 nodes, `Transform` category) ✅ Complete
- [x] Polar Coordinates — cartesian ↔ polar conversion with center params
- [x] Tile — repeat + optional mirror with countX/countY params

### Sprint 4 — Math Expansion (3 nodes, `Math` category) ✅ Complete
- [x] Clamp — value + min + max → clamped float
- [x] Power — base + exponent → float
- [x] Round — value → float with mode enum (floor/ceil/fract/round/sign)

### Sprint 5 — Color Expansion (3 nodes, `Color` category) ✅ Complete
- [x] Invert — vec3(1.0) - color
- [x] Grayscale — color → float with mode enum (luminance/average/lightness)
- [x] Posterize — quantize color to N levels

### Sprint 6 — Cmd+K Node Search Palette ✅ Complete
- [x] Command palette overlay with fuzzy search over node types
- [x] Keyboard: Cmd+K / Cmd+/ opens, arrows navigate, Enter places, Escape closes
- Files: `src/components/CommandPalette.tsx` (new), `src/utils/fuzzy-search.ts` (new), `src/App.tsx` (modified)

**Milestone:** Rich enough node library to recreate complex shaders entirely in the editor. **Phase 4 complete: 39 nodes + Cmd+K search.**

---

## Phase 5 — Compact URLs + Per-Node Mini-Previews ✅ Complete

### Sprint 1 — Compact Viewer URLs ✅
- `CompactGraph` format: strips positions, RF metadata, default params, uses short keys (`i`, `t`, `p`, `s`, `sh`, `th`)
- New `#g=` hash prefix (50-70% shorter URLs). Old `#graph=` still works (backwards compat)
- `encodeCompactHash()` / `decodeCompactHash()` in `sombra-file.ts`
- GraphToolbar + dev-bridge switched to compact format

### Sprint 2 — Subgraph Compiler ✅
- `compileNodePreview(nodes, edges, targetNodeId)` in `subgraph-compiler.ts`
- Generalized `topologicalSort` with optional `startNodeId` parameter
- Output type → fragColor mapping: float→grayscale, vec2→RG, vec3/color→RGB, vec4→pass-through
- Exported `assembleFragmentShader`, `formatDefaultValue` from `glsl-generator.ts`
- Worker handles `'preview'` message type alongside `'compile'`

### Sprint 3 — Offscreen Preview Renderer ✅
- `PreviewRenderer` class: single offscreen WebGL2 context (80×80), FBO, readPixels → data URL
- Shader program LRU cache (64 entries), built-in + user uniform upload
- No extra DOM elements — fully offscreen

### Sprint 4 — Preview Store + Scheduler ✅
- `PreviewScheduler`: Worker-based compilation, one stale node per RAF tick
- Dependency tracking via BFS forward adjacency (marks downstream nodes stale)
- Time-dependent nodes re-render at 10 FPS (100ms interval)
- `previewStore` (Zustand): ephemeral `nodeId → dataUrl` map

### Sprint 5 — UI Integration ✅
- 80×80 preview thumbnail at bottom of each ShaderNode (except fragment_output)
- Scheduler initialized in App.tsx, wired to graph store changes
- Previews update reactively when params or connections change

**Milestone:** Viewer URLs are 50-70% shorter. Every node shows a live preview thumbnail of its output.

---

## Phase 6 — Future (Trigger-Based, Not Scheduled)

These happen when specific conditions are met, not on a timeline:

- Backend + shareable URLs (trigger: user demand) — Vercel + Supabase
- Public gallery (trigger: enough users creating materials)
- Texture/image uploads as sampler2D inputs
- 3D mesh preview (apply shader to a sphere/cube)
- Real-time collaboration
- WebGPU compute backend
- MaterialX / glTF export

### Backlog (moved from earlier phases)

- Refactor node previews — v1 works but needs polish (rendering quality, layout/sizing, performance tuning, visual integration with node cards)
- "Copy GLSL" button — exports the compiled fragment shader to clipboard
- Embed HTML snippet generator
- Viewer page branded landing — show Sombra branding when opened without graph data
- Subgraphs — group nodes into reusable compound nodes
- Custom GLSL Node — paste arbitrary GLSL with user-defined ports
- Shadertoy/GLSL Sandbox import adapters

---

## Relationship to spectra-pixel-bg

spectra-pixel-bg continues to power spendolas.com unchanged. Phase 2 brings spectra's noise types, fractal modes, color palettes, and pixel rendering into Sombra as composable nodes. The 4 spectra presets (Value FBM, Simplex FBM, Worley Ridged, Box None) become buildable as node graphs in Phase 2, with polished preset files shipped in Phase 5. Eventually spendolas.com could embed a sombra-built material directly.
