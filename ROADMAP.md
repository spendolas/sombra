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

### Sprint 1 — Infrastructure + UX Polish

#### A. Compiler Improvements

**Shared GLSL function deduplication.** Currently each node instance pushes its own copy of helper functions (e.g., `snoise_nodeId()`). Add a `functionRegistry: Map<string, string>` to `GLSLContext`. New helper `addFunction(ctx, key, code)` skips if key already registered. `assembleFragmentShader()` emits from the registry instead of raw `functions[]`.

- [x] Add `functionRegistry` to `GLSLContext` (`src/nodes/types.ts`)
- [x] Update `assembleFragmentShader()` to use registry (`src/compiler/glsl-generator.ts`)
- [x] Migrate existing simplex noise to shared functions (template for all noise nodes)

**Enum parameter type.** Several new nodes need dropdown selectors (FBM noise type, fractal mode, Color Ramp interpolation, Pixel Grid shape). Add `'enum'` to `NodeParameter.type` with `options?: Array<{ value: string; label: string }>`. Render as shadcn `<Select>` in `NodeParameters.tsx`.

- [x] Extend `NodeParameter` interface (`src/nodes/types.ts`)
- [x] Add enum renderer to `NodeParameters.tsx`

#### B. Connection UX Polish

**Connector color coding.** Edges colored by source port type using the existing color map (float→gray, vec2→emerald, vec3→blue, vec4→purple, color→amber, sampler2D→pink). Fix the existing bug where `--handle-color` is set but never visually applied to handles.

- [x] Custom edge component with per-type coloring (`src/components/TypedEdge.tsx`)
- [x] Register custom edge type in `FlowCanvas.tsx`
- [x] Store source port type in edge data
- [x] Fix handle color rendering in `base-handle.tsx` / `labeled-handle.tsx`

**Reconnectable edges.** Enable React Flow's built-in reconnect so users can drag an existing edge endpoint to a new port.

- [x] Add `edgeReconnectMode` + handlers to `FlowCanvas.tsx`

**Delete edge on drop.** Dragging an edge away and dropping on empty canvas deletes it.

- [x] Use `onReconnectEnd` to detect drops on empty space

**Proximity connect.** Auto-snap to compatible ports when dragging a connection nearby.

- [x] Add `connectionRadius` prop to ReactFlow

**Single wire per input (swap behavior).** Inputs accept only one connection. New edge to an already-connected input replaces the existing one.

- [x] In `onConnect`, check for existing edges to target input and remove before adding

**Used/unused port distinction.** Connected handles render filled with type color; unconnected render as hollow outlines.

- [x] Pass connection status to handle component
- [x] Style connected vs unconnected handles differently

### Sprint 2 — Noise Primitives (4 nodes + 1 upgrade)

All noise nodes share the same interface: `coords` (vec2) + `z` (float, for time animation) + `scale` (float) → `value` (float, 0-1).

- [x] **Simplex Noise 3D** — Upgrade existing 2D to 3D. Add `z` input (`src/nodes/noise/simplex-noise.ts`)
- [x] **Value Noise 3D** — Hash-based 3D noise with trilinear interpolation (`src/nodes/noise/value-noise.ts`)
- [x] **Worley Noise** — Cellular/Voronoi distance field with 3x3x3 neighbor search (`src/nodes/noise/worley-noise.ts`)
- [x] **Box Noise** — Quantized value noise with `boxFreq` parameter (`src/nodes/noise/box-noise.ts`)

### Sprint 3 — Fractal & Warp Layer (4 nodes)

- [x] **FBM** — Multi-octave fractal accumulator. Embeds all 4 noise types internally (enum param) because the fractal loop must re-sample at different frequencies. Params: `noiseType` (enum: value/simplex/worley/box), `fractalMode` (enum: standard/turbulence/ridged), `octaves` (1-8), `lacunarity`, `gain` (`src/nodes/noise/fbm.ts`)
- [x] **Turbulence** — Standalone remap: `abs(n * 2.0 - 1.0)`. Usable outside FBM for general remapping (`src/nodes/noise/turbulence.ts`)
- [x] **Ridged** — Standalone remap: `(1.0 - abs(n * 2.0 - 1.0))^2` (`src/nodes/noise/ridged.ts`)
- [x] **Domain Warp** — Distorts coordinates using value noise. Inputs: `coords` (vec2), `strength` (float). Output: `warped` (vec2) (`src/nodes/noise/domain-warp.ts`)

### Sprint 4 — UV & Input Nodes (4 nodes)

- [ ] **Rotate UV** — 2D rotation around (0.5, 0.5). Input: `angle` (float, radians). Maps to spectra's `angle` param (`src/nodes/input/rotate-uv.ts`)
- [ ] **Scale UV** — Scale from center (`src/nodes/input/scale-uv.ts`)
- [ ] **Offset UV** — Translate coordinates. Maps to spectra's `flow` (animated offset via Time) (`src/nodes/input/offset-uv.ts`)
- [ ] **Vec2 Constant** — Output a static vec2 value (`src/nodes/input/vec2-constant.ts`)

### Sprint 5 — Color Ramp (1 node, biggest single item)

General-purpose multi-stop gradient mapper: float (0-1) → color (vec3). This is the scalable replacement for spectra's fixed 7-color palette system — arbitrary number of stops, usable by any future node library.

- [ ] **Color Ramp node** — GLSL: chain of `mix()` + `smoothstep()` for linear/smooth, `step()` for constant interpolation (`src/nodes/color/color-ramp.ts`)
- [ ] **ColorRampEditor component** — interactive gradient bar with draggable stops, per-stop color pickers, interpolation mode dropdown (`src/components/ColorRampEditor.tsx`)
- [ ] **6 palette presets** — Cobalt Drift, Violet Ember, Teal Afterglow, Solar Ember, Citrus Pulse, Rose Heat (from spectra-pixel-bg)
- [ ] Stops stored as `params.stops` (serializable array), UI via `component` field — no changes to `NodeParameter` type system needed

### Sprint 6 — Pixel Rendering (2 nodes)

- [ ] **Pixel Grid** — Post-processing node: quantization + Bayer 8x8 dithering + shape SDF (circle/triangle/diamond). Inputs: `color` (vec3), `coords` (vec2). Params: `pixelSize` (2-20), `shape` (enum), `dither` (0-1) (`src/nodes/postprocess/pixel-grid.ts`)
- [ ] **Bayer Dither** — Standalone 8x8 Bayer dither pattern. Outputs threshold float for current pixel. Enables creative dithering beyond pixel art (`src/nodes/postprocess/bayer-dither.ts`)

### Node Summary

| # | Node | Category | Status |
|---|------|----------|--------|
| 1 | Simplex Noise 3D | Noise | Upgrade |
| 2 | Value Noise 3D | Noise | New |
| 3 | Worley Noise | Noise | New |
| 4 | Box Noise | Noise | New |
| 5 | FBM | Noise | New |
| 6 | Turbulence | Noise | New |
| 7 | Ridged | Noise | New |
| 8 | Domain Warp | Noise | New |
| 9 | Rotate UV | Input | New |
| 10 | Scale UV | Input | New |
| 11 | Offset UV | Input | New |
| 12 | Vec2 Constant | Input | New |
| 13 | Color Ramp | Color | New |
| 14 | Pixel Grid | Post-process | New |
| 15 | Bayer Dither | Post-process | New |

**Total after Phase 2: 30 nodes** (16 existing + 15 new - 1 upgrade)

### Key Files

| File | Modifications |
|------|---------------|
| `src/nodes/types.ts` | Add `functionRegistry` to `GLSLContext`, `'enum'` to `NodeParameter` |
| `src/compiler/glsl-generator.ts` | Function deduplication, registry initialization |
| `src/components/NodeParameters.tsx` | Enum/select renderer |
| `src/components/FlowCanvas.tsx` | Edge reconnect, proximity connect, connection radius, edge types |
| `src/components/TypedEdge.tsx` | New — custom edge with port-type coloring |
| `src/components/base-handle.tsx` | Fix handle color rendering |
| `src/components/labeled-handle.tsx` | Connected/unconnected visual states |
| `src/components/ShaderNode.tsx` | Pass connection status to handles |
| `src/components/ColorRampEditor.tsx` | New — gradient editor widget |
| `src/nodes/index.ts` | Register all new nodes |
| `src/App.tsx` | Edge swap logic in `onConnect` |

### Success Criteria

1. All 4 spectra noise types exist as 3D nodes with `coords` + `z` inputs
2. FBM supports standard/turbulence/ridged modes for all 4 noise types
3. Domain Warp distorts coordinates with adjustable strength
4. Color Ramp maps float → color via interactive gradient editor with 6 spectra palette presets
5. Pixel Grid renders pixel art with circle/triangle/diamond shapes + Bayer dithering
6. UV nodes (rotate, scale, offset) enable spectra's `angle` and `flow` behaviors
7. **Acceptance test:** manually wire graphs that visually reproduce each of the 4 spectra presets
8. Edges color-coded by port type, reconnectable, delete-on-drop, proximity-connect, single-wire-per-input
9. Connected/unconnected handles visually distinct
10. No regressions to existing 16 nodes or live preview pipeline

**Milestone:** 30-node editor that can recreate all spectra-pixel-bg effects as composable node graphs, with polished connection UX.

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
