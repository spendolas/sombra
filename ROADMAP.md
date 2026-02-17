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

## Phase 2 — Spectra Mode + UX Polish

**Goal:** Replicate the full spectra-pixel-bg noise/color/pixel experience as composable node-graph features, and polish the connection UX. When complete, all four spectra presets (Value FBM, Simplex FBM, Worley Ridged, Box None) can be recreated as node graphs, plus novel combinations that spectra-pixel-bg could never express.

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

All noise nodes share the same interface: `coords` (vec2) + `z` (float, for time animation) + `scale` (float) → `value` (float, 0-1).

- [x] **Simplex Noise 3D** — Upgraded to 3D with `z` input (`src/nodes/noise/simplex-noise.ts`)
- [x] **Value Noise 3D** — Hash-based 3D noise (`src/nodes/noise/value-noise.ts`)
- [x] **Worley Noise** — Cellular/Voronoi distance field (`src/nodes/noise/worley-noise.ts`)
- [x] **Box Noise** — Quantized value noise with `boxFreq` (`src/nodes/noise/box-noise.ts`)

### Sprint 3 — Fractal & Warp Layer ✅ Complete

- [x] **FBM** — Multi-octave fractal accumulator with `noiseType` enum + `fractalMode` enum (`src/nodes/noise/fbm.ts`)
- [x] **Turbulence** — Standalone remap: `abs(n * 2.0 - 1.0)` (`src/nodes/noise/turbulence.ts`)
- [x] **Ridged** — Standalone remap: `(1.0 - abs(n * 2.0 - 1.0))^2` (`src/nodes/noise/ridged.ts`)
- [x] **Domain Warp** — Coordinate distortion using value noise (`src/nodes/noise/domain-warp.ts`)

### Sprint 4 — Unified Noise Node + fnref Revisions + Cleanup

**Goal:** Consolidate 4 separate noise nodes into 1 unified Noise node (Redshift-style), make FBM and Domain Warp composable via `fnref`, and move Turbulence/Ridged to Math.

#### Unified Noise Node

Replace `simplex-noise.ts`, `value-noise.ts`, `worley-noise.ts`, `box-noise.ts` with a single `noise.ts`. One node with a `noiseType` dropdown (simplex/value/worley/box). Changing noise type = dropdown change, no rewiring. Outputs: `value` (float) + `fn` (fnref). The `fn` output dynamically provides the selected noise type's function name.

- [ ] Create `src/nodes/noise/noise.ts` — unified noise node with type enum
- [ ] Delete 4 old files: `simplex-noise.ts`, `value-noise.ts`, `worley-noise.ts`, `box-noise.ts`

#### Dynamic `functionKey`

`NodeDefinition.functionKey` changes from `string` to `string | ((params) => string)`. The unified node returns the selected noise type's function name dynamically. Compiler resolves by calling the function with source node's params.

- [ ] Update `functionKey` type in `src/nodes/types.ts`
- [ ] Update fnref resolution in `src/compiler/glsl-generator.ts` to handle dynamic functionKey

#### FBM — fnref input (revise)

Remove `noiseType` enum param, add `noiseFn` fnref input. Keep `fractalMode` enum (standard/turbulence/ridged). When unconnected, falls back to simplex and registers its GLSL.

- [ ] Revise `src/nodes/noise/fbm.ts`

#### Domain Warp — fnref input (revise)

Add `noiseFn` fnref input (default: value noise). When unconnected, registers fallback GLSL.

- [ ] Revise `src/nodes/noise/domain-warp.ts`

#### Move Turbulence & Ridged to Math

These are general-purpose signal remaps (`float → float`), not noise-specific.

- [ ] Move `src/nodes/noise/turbulence.ts` → `src/nodes/math/turbulence.ts`, change `category: 'Math'`
- [ ] Move `src/nodes/noise/ridged.ts` → `src/nodes/math/ridged.ts`, change `category: 'Math'`

#### Other

- [ ] Update `src/nodes/index.ts` — replace 4 noise imports with 1, update turbulence/ridged paths
- [ ] Add `fnref` color to handle/edge color map
- [x] Right-align output port labels (`labeled-handle.tsx`) ✅ Done

### Sprint 5 — UV & Input Nodes (4 nodes)

- [ ] **Rotate UV** — 2D rotation around (0.5, 0.5). Input: `angle` (float, radians). Maps to spectra's `angle` param (`src/nodes/input/rotate-uv.ts`)
- [ ] **Scale UV** — Scale from center (`src/nodes/input/scale-uv.ts`)
- [ ] **Offset UV** — Translate coordinates. Maps to spectra's `flow` (animated offset via Time) (`src/nodes/input/offset-uv.ts`)
- [ ] **Vec2 Constant** — Output a static vec2 value (`src/nodes/input/vec2-constant.ts`)

### Sprint 6 — Color Ramp (1 node, biggest single item)

General-purpose multi-stop gradient mapper: float (0-1) → color (vec3). This is the scalable replacement for spectra's fixed 7-color palette system — arbitrary number of stops, usable by any future node library.

- [ ] **Color Ramp node** — GLSL: chain of `mix()` + `smoothstep()` for linear/smooth, `step()` for constant interpolation (`src/nodes/color/color-ramp.ts`)
- [ ] **ColorRampEditor component** — interactive gradient bar with draggable stops, per-stop color pickers, interpolation mode dropdown (`src/components/ColorRampEditor.tsx`)
- [ ] **6 palette presets** — Cobalt Drift, Violet Ember, Teal Afterglow, Solar Ember, Citrus Pulse, Rose Heat (from spectra-pixel-bg)
- [ ] Stops stored as `params.stops` (serializable array), UI via `component` field — no changes to `NodeParameter` type system needed

### Sprint 7 — Pixel Rendering (2 nodes)

- [ ] **Pixel Grid** — Post-processing node: quantization + Bayer 8x8 dithering + shape SDF (circle/triangle/diamond). Inputs: `color` (vec3), `coords` (vec2). Params: `pixelSize` (2-20), `shape` (enum), `dither` (0-1) (`src/nodes/postprocess/pixel-grid.ts`)
- [ ] **Bayer Dither** — Standalone 8x8 Bayer dither pattern. Outputs threshold float for current pixel. Enables creative dithering beyond pixel art (`src/nodes/postprocess/bayer-dither.ts`)

### Node Summary (After Sprint 4)

| Node | Category | fnref | Notes |
|------|----------|-------|-------|
| **Noise** | Noise | outputs (dynamic) | Unified: simplex/value/worley/box via dropdown |
| **FBM** | Noise | consumes fnref | Revised: wirable noise input |
| **Domain Warp** | Noise | consumes fnref | Revised: wirable noise input |
| **Turbulence** | Math | — | Moved from Noise (general signal remap) |
| **Ridged** | Math | — | Moved from Noise (general signal remap) |
| Rotate UV | Input | — | Sprint 5 |
| Scale UV | Input | — | Sprint 5 |
| Offset UV | Input | — | Sprint 5 |
| Vec2 Constant | Input | — | Sprint 5 |
| Color Ramp | Color | — | Sprint 6 |
| Pixel Grid | Post-process | — | Sprint 7 |
| Bayer Dither | Post-process | — | Sprint 7 |

**After Sprint 4: 20 nodes** (4 separate noise → 1 unified = net -3). **After Phase 2: 27 nodes.**

### Key Files

| File | Sprint 4 Changes |
|------|-----------------|
| `src/nodes/noise/noise.ts` | **New** — unified noise node (replaces 4 files) |
| `src/nodes/types.ts` | `functionKey` becomes `string \| ((params) => string)` |
| `src/compiler/glsl-generator.ts` | Dynamic functionKey resolution for fnref |
| `src/nodes/noise/fbm.ts` | Replace `noiseType` enum with `noiseFn` fnref input |
| `src/nodes/noise/domain-warp.ts` | Add `noiseFn` fnref input |
| `src/nodes/math/turbulence.ts` | Moved from `noise/`, category → Math |
| `src/nodes/math/ridged.ts` | Moved from `noise/`, category → Math |
| `src/nodes/index.ts` | Replace 4 noise imports with 1, update turbulence/ridged paths |
| `src/components/ColorRampEditor.tsx` | Sprint 6 — gradient editor widget |

### Success Criteria

1. Unified Noise node with type dropdown (simplex/value/worley/box) + dual outputs (value + fn)
2. FBM accepts wired noise via `fnref` input — wire Noise `fn` → FBM, change dropdown to switch noise type
3. FBM supports standard/turbulence/ridged fractal modes via enum param
4. Domain Warp accepts wired noise via `fnref` input
5. Turbulence and Ridged nodes appear under Math category
6. Color Ramp maps float → color via interactive gradient editor with 6 spectra palette presets
7. Pixel Grid renders pixel art with circle/triangle/diamond shapes + Bayer dithering
8. UV nodes (rotate, scale, offset) enable spectra's `angle` and `flow` behaviors
9. **Acceptance test:** manually wire graphs that visually reproduce each of the 4 spectra presets
10. No regressions to live preview pipeline

**Milestone:** Composable noise→FBM node graph system that can recreate all spectra-pixel-bg effects.

---

## Phase 3 — Save/Load/Export

- localStorage auto-save with schema versioning
- JSON download/upload for sharing graph files
- "Copy GLSL" button — exports the compiled fragment shader
- Embed HTML snippet generator
- `/embed.html?material=<base64>` shareable URLs (still static, no backend)

**Milestone:** Save your work, share a link, copy the shader code.

---

## Phase 4 — Node Library Expansion

- **Patterns:** Checkerboard, Stripes, Dots, Voronoi
- **Distortion:** Polar Coordinates
- **More Math/Vector/Color nodes** as needed
- **Subgraphs:** Group nodes into reusable compound nodes
- **Custom GLSL Node:** Paste arbitrary GLSL with user-defined ports
- **Shadertoy/GLSL Sandbox import adapters**
- Cmd+K node search palette
- Undo/redo, keyboard shortcuts

**Milestone:** Rich enough node library to recreate complex shaders entirely in the editor.

---

## Phase 5 — Polish & Performance

- Final visual design (Figma-driven), dark/light themes, responsive layout
- Lazy compilation, FPS throttling, React Flow virtualization for large graphs
- Spectra preset example graphs (the 4 presets as loadable node graphs)
- Example materials library, onboarding flow / tutorial
- Per-node mini-previews via single offscreen WebGL context

**Milestone:** Polished, performant, with built-in examples that showcase what's possible.

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

---

## Relationship to spectra-pixel-bg

spectra-pixel-bg continues to power spendolas.com unchanged. Phase 2 brings spectra's noise types, fractal modes, color palettes, and pixel rendering into Sombra as composable nodes. The 4 spectra presets (Value FBM, Simplex FBM, Worley Ridged, Box None) become buildable as node graphs in Phase 2, with polished preset files shipped in Phase 5. Eventually spendolas.com could embed a sombra-built material directly.
