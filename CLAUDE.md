# Sombra - Project Guide for Claude Code

## Project Overview

**Sombra** is a browser-based, node-based WebGL shader builder. Users wire visual nodes together on a canvas to create fragment shaders, with a live fullscreen preview updating in real time. Think Shadertoy meets Blender's shader nodes, in the browser.

**Repository:** `spendolas/sombra`
**Deploy target:** `spendolas.github.io/sombra` via GitHub Pages
**Tech:** Vite, React 19 + TypeScript (strict mode), React Flow, Zustand, Tailwind CSS v4, Raw WebGL2

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Build | Vite | Fast dev server, ESM-native |
| UI Framework | React 19 + TypeScript | Strict mode enabled |
| Node Canvas | @xyflow/react (React Flow v12) | Purpose-built node editor |
| State | Zustand | Lightweight, integrates well with React Flow |
| UI Components | shadcn/ui + react-resizable-panels | Headless components, resizable layout |
| Styling | Tailwind CSS v4 | Utility-first, Vite plugin integration |
| WebGL | Raw WebGL2 | No Three.js - output is fragment shaders only |
| GLSL | GLSL ES 3.0 | Modern syntax, 97%+ browser support |
| Backend | None (Phase 0-4) | localStorage + JSON export, static site |
| Deploy | GitHub Pages | Free hosting at `/sombra/` base path |

## Project Structure

```
sombra/
├── src/
│   ├── components/      # React components (panels, toolbar, UI widgets)
│   │   ├── ui/          # shadcn/ui primitives (button, slider, input, etc.)
│   │   ├── base-node.tsx       # React Flow BaseNode wrapper
│   │   ├── labeled-handle.tsx  # React Flow typed handle with label
│   │   └── zoom-slider.tsx     # React Flow zoom control
│   ├── lib/             # Utility functions (cn helper, etc.)
│   ├── nodes/           # Node type definitions (one file per category or node)
│   ├── compiler/        # Graph-to-GLSL compiler logic
│   ├── stores/          # Zustand stores for app state
│   ├── webgl/           # WebGL renderer (fullscreen quad, offscreen preview)
│   ├── App.tsx          # Root layout component
│   ├── main.tsx         # Entry point
│   └── index.css        # Tailwind imports + dark theme base styles
├── components.json      # shadcn/ui configuration
├── public/              # Static assets
├── ROADMAP.md           # Detailed roadmap (Phases 0-5)
├── CLAUDE.md            # This file
└── package.json
```

## Key Conventions

- **TypeScript strict mode** everywhere - no implicit any, strict null checks
- **Tailwind utility classes only** - no per-component CSS files, no inline `style={{}}` for colors
- **Dark theme** - base background `#0f0f1a`, Sombra tokens registered in Tailwind `@theme inline`
- **Imperative WebGL** - direct WebGL2 API, no abstraction libraries
- **Single offscreen context** - for node previews, avoids context limit (8-16)
- **Component naming** - PascalCase for React components, camelCase for utilities
- **File organization** - one node type per file in `src/nodes/`, grouped by category

## Commands

```bash
npm run dev      # Start dev server (http://localhost:5173)
npm run build    # Production build (outputs to dist/)
npm run lint     # Run ESLint
npm run preview  # Preview production build locally
```

## Architecture

### WebGL Rendering

- **Fullscreen quad**: 2 triangles covering clip space (-1 to 1), vertex shader passes through, fragment shader does all the work
- **Shader compilation**: Graph nodes → topological sort → GLSL code generation → WebGL program compilation
- **Uniforms**: Built-in `u_time`, `u_resolution`, `u_mouse`, `u_ref_size`; user-defined uniforms from node parameters
- **Frozen reference sizing**: `u_ref_size` captures `min(width, height)` on first render and never changes. The UV node uses `(v_uv - 0.5) * u_resolution / u_ref_size + 0.5` so each axis scales independently — resizing reveals/hides edges without zoom or distortion
- **Preview rendering**: Single offscreen WebGL context captures frames to `<img>` for per-node previews

### Node System

Nodes have:
- **Type** (e.g., `noise`, `mix`, `uv_coords`)
- **Inputs/Outputs** with typed ports (float, vec2, vec3, vec4, color, sampler2D, fnref)
- **Parameters** with default values
- **GLSL generator function** - emits GLSL code snippet given inputs/outputs/params
- **Optional `functionKey`** - GLSL function name for fnref outputs (`string` or `(params) => string` for dynamic)
- **Optional custom UI** - React component for node body (e.g., color picker, sliders)

### State Management

- **Zustand stores** for app-wide state (nodes, edges, settings, undo/redo history)
- **React Flow** manages canvas state (pan, zoom, selection)
- **localStorage** auto-saves graph state with versioned schema

## Development Workflow

1. **Adding a new node type**:
   - Create a file in `src/nodes/<category>/` (e.g., `src/nodes/noise/simplex.ts`)
   - Define `NodeDefinition` with inputs, outputs, defaults, GLSL generator
   - Register in node registry
   - Add to node palette UI

2. **Updating the compiler**:
   - Modify `src/compiler/` to handle new port types or conversions
   - Ensure topological sort handles new edge cases
   - Map shader errors back to nodes for debugging

3. **Adding UI components**:
   - Use `npx shadcn@latest add <component>` to add new shadcn/ui primitives
   - Components land in `src/components/ui/`; configure via `components.json`
   - Note: `react-resizable-panels` v4 API differs from shadcn's v3 wrapper — see `resizable.tsx` patch

4. **Styling**:
   - Use Tailwind utility classes directly in JSX — never inline `style={{}}` for Sombra tokens
   - Use Sombra design tokens: `bg-surface`, `text-fg-dim`, `border-edge`, etc. (see Design Tokens below)
   - shadcn/ui components use their own oklch tokens (`--background`, `--foreground`, etc.) — don't mix
   - React Flow components that only accept `style` props (not `className`) may use `var(--surface)` etc.
   - Base dark theme colors defined in `src/index.css` `:root` block

5. **Testing**:
   - Manual testing via dev server (`npm run dev`)
   - Shader compilation errors logged to console with node IDs
   - Future: Unit tests for compiler, integration tests for rendering

## Deployment

- **GitHub Actions workflow** (`.github/workflows/deploy.yml`) builds on push to `main`
- Outputs `dist/` to `gh-pages` branch
- Site available at `https://spendolas.github.io/sombra/`
- Vite config has `base: '/sombra/'` for correct asset paths

## Phase 0 Status

✅ Complete — Scaffold, React Flow canvas, WebGL2 renderer, GitHub Pages deployment.

## Next Steps (Phase 3)

Phase 2 is complete — all 23 nodes delivered, all 4 spectra presets reproducible as node graphs.

See `ROADMAP.md` for Phase 3 (Save/Load/Export): localStorage auto-save with schema versioning, JSON download/upload, "Copy GLSL" button, embed HTML snippet generator.

## Design Decisions (Why We Did It This Way)

**Why no Three.js?**
All output is 2D fragment shaders on a fullscreen quad. Three.js adds complexity (scene graph, cameras, mesh management) we don't need. Raw WebGL2 is simpler and more direct.

**Why Zustand over Redux/Context?**
Lightweight, minimal boilerplate, pairs naturally with React Flow's own state. Redux would be overkill for this project's scope.

**Why Tailwind v4 (Vite plugin)?**
Faster than PostCSS setup, cleaner integration. v4's Vite plugin is the recommended approach for new projects.

**Why static site / no backend initially?**
Keeps architecture simple. localStorage + JSON export covers MVP use cases. Backend added later (Phase 5) only when sharing/gallery features demand it.

**Why GitHub Pages?**
Free, simple, integrates well with GitHub Actions. Custom domain can be added later if needed.

## Resources

- [React Flow docs](https://reactflow.dev/)
- [Zustand docs](https://zustand-demo.pmnd.rs/)
- [Tailwind CSS v4 docs](https://tailwindcss.com/docs)
- [WebGL2 fundamentals](https://webgl2fundamentals.org/)
- [GLSL ES 3.0 spec](https://www.khronos.org/registry/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)

## Tips for Future Sessions

- Always read `ROADMAP.md` before starting a new phase
- Check `src/` structure before creating new files - follow existing patterns
- When adding nodes, mimic existing node structure in `src/nodes/`
- Shader errors are mapped back to node IDs - look for console logs
- Use `npm run lint` before committing to catch TypeScript errors early
- Test WebGL changes in multiple browsers (Chrome, Firefox, Safari) - shader compilation can vary

## Current Phase

**Phase 0** - ✅ Complete
**Phase 1** - ✅ Complete (16 nodes, compiler, live preview, full reactive pipeline)
**Phase 1.2** - ✅ Complete (UI polish, resizable layout, frozen-ref preview)
**Phase 2** - ✅ Complete (Spectra Mode + UX Polish — 23 nodes, all spectra presets reproducible)

### Phase 2 — Spectra Mode + UX Polish

Replicate the full spectra-pixel-bg experience as composable node-graph features, plus connection UX polish. See `ROADMAP.md` for the full brief with sprint breakdown.

**Sprint 1 — Infrastructure + UX Polish** ✅ Complete
- Compiler: `functionRegistry` on `GLSLContext` with `addFunction()` for shared GLSL deduplication
- `'enum'` parameter type with shadcn `<Select>` renderer
- Handle colors: `BaseHandle` uses `handleColor` + `connected` props (filled/hollow)
- `TypedEdge` component with port-type edge coloring, `sourcePortType` in `EdgeData`
- Reconnectable edges, delete-on-drop, proximity connect (`connectionRadius=20`), single-wire-per-input swap in `onConnect`

**Sprint 2 — Noise Primitives** ✅ Complete
- Simplex 3D (upgrade), Value 3D, Worley, Box noise — all with `coords` + `z` + `scale` → `value`

**Sprint 3 — Fractal & Warp** ✅ Complete
- FBM (with `noiseType` enum + `fractalMode` enum), Turbulence, Ridged, Domain Warp

**Sprint 4 — Unified Noise Node + fnref + Cleanup** ✅ Complete
- `fnref` port type: carries GLSL function names for higher-order composition
- Unified **Noise** node (`noise.ts`) with `noiseType` dropdown (simplex/value/worley/box), dual outputs (value + fn)
- Dynamic `functionKey`: `string | ((params) => string)` — fnref output adapts to selected noise type
- Compiler: `glsl-generator.ts` resolves dynamic functionKey by calling it with source node params
- FBM & Domain Warp accept `noiseFn` fnref input, register fallback GLSL when unconnected
- Turbulence & Ridged moved to Math category
- `NodeParameter.showWhen` for conditional param visibility (boxFreq only shown for box noise)
- fnref color (cyan `#22d3ee`) in handle/edge maps, right-aligned output labels

**Sprint 4.5 — Connectable Parameters** ✅ Complete
- `connectable?: boolean` flag on `NodeParameter` — inline handle + slider, dims when wired
- Compiler: connectable params resolved as inputs (wired → source var, unwired → slider value)
- `ShaderNode.tsx` layout rework: pure inputs → connectable param rows → outputs → regular params
- `formatDefaultValue` outputs proper GLSL float literals (5 → "5.0")
- FBM refactor: lacunarity/gain as function args (wirable)
- Domain Warp: strength/frequency connectable
- Mix: factor connectable
- Brightness/Contrast: brightness/contrast connectable
- `isValidConnection` checks connectable params as valid connection targets

**Sprint 4.75 — Math Consolidation + UX Polish** ✅ Complete
- Unified **Arithmetic** node (add/sub/mul/div + dynamic 2-8 inputs via +/- buttons)
- Unified **Trig** node (sin/cos/tan/abs + connectable freq/amp)
- `dynamicInputs?: (params) => PortDefinition[]` on `NodeDefinition` for variable port count
- `hidden?: boolean` on `NodeParameter` for internal params (inputCount)
- Node layout: outputs above inputs, category removed from header
- Source value resolution: connected params show actual source value (constants) or "← SourceLabel" (dynamic)
- `PropertiesPanel` connection awareness: reads edges, builds `connectedSources` map with resolved values
- Noise `boxFreq` now connectable; FBM `octaves` now connectable (max-bound loop with early break)
- Node count: 18 (was 20 — delete add/multiply/sin/cos, add arithmetic/trig)

**Sprint 5 — UV Transform + Vec2 Constant** ✅ Complete
- Extended **UV Coordinates** node with 5 connectable SRT params: scaleX, scaleY (non-uniform), rotate, offsetX, offsetY
- GLSL: center → scale → rotate (2D matrix) → offset + re-center. Frozen-ref sizing preserved.
- New **Vec2 Constant** node: X/Y float sliders → vec2 output
- Follows Redshift UV Projection pattern: transform controls on the coordinate source, not separate nodes
- Files: modified `uv-coords.ts`, created `vec2-constant.ts`, updated `index.ts`
- Node count: 19 (was 18 — 1 new Vec2 Constant, UV Coords modified not added)

**Sprint 5.5 — Auto UV Default + Phase Rename** ✅ Complete
- **Compiler `auto_uv` sentinel**: `PortDefinition.default: 'auto_uv'` on vec2 inputs. Compiler generates frozen-ref UV inline when unconnected. Noise nodes produce visible patterns without wiring UV Coordinates.
- **Rename `z` → `phase`**: All 3 noise nodes (Noise, FBM, Domain Warp). Port id, label, GLSL refs. Communicates animation/evolution purpose.
- Default test graph simplified: removed UV Coordinates node (auto_uv makes it unnecessary)
- Node count: still 19 (no new nodes)

**Sprint 5.75 — Design Token Unification** ✅ Complete
- Renamed 13 CSS vars: `--bg-primary` → `--surface`, `--text-primary` → `--fg`, `--border-primary` → `--edge`, `--accent-primary` → `--indigo`, etc.
- Registered all tokens in Tailwind `@theme inline` as `--color-*` entries
- Converted 48 inline `style={{}}` to Tailwind utility classes across 8 files
- Only justified inline styles remain: React Flow component props + dynamic runtime `handleColor`
- shadcn oklch tokens kept separate (no visual regressions in shadcn primitives)

**Sprint 6 — Color Ramp** ✅ Complete
- Color Ramp node: multi-stop gradient mapper (`float 0-1 → vec3 color`) with smooth/linear/constant interpolation
- `ColorRampEditor` component: draggable stops, per-stop color picker, 6 palette presets (Cobalt Drift, Violet Ember, Teal Afterglow, Solar Ember, Citrus Pulse, Rose Heat)
- Figma DS: Gradient Editor molecule (`50:4208`), Color Ramp template (`50:4226`), Palette Item (`50:4260`) — all variable-bound
- Files: `src/nodes/color/color-ramp.ts`, `src/components/ColorRampEditor.tsx`, modified `src/nodes/index.ts`

**Sprint 7 — Pixel Rendering** ✅ Complete
- **Pixel Grid** node: quantization + Bayer 8×8 dithering + shape SDF masking (circle/diamond/triangle)
- **Bayer Dither** node: standalone 8×8 ordered dither threshold pattern
- New `Post-process` category with shared `bayer8x8` function (bit-interleave, deduped via `addFunction`)
- Shape SDFs registered with per-shape keys (`sdf_circle`, `sdf_diamond`, `sdf_triangle`) for multi-instance safety
- Connectable params: `pixelSize`, `dither` on Pixel Grid
- Files: `src/nodes/postprocess/pixel-grid.ts`, `src/nodes/postprocess/bayer-dither.ts`, modified `src/nodes/index.ts`

**Visual Parity Fix** ✅ Complete
- **Pixel Grid** + **Bayer Dither**: removed `coords` input, now use `gl_FragCoord.xy` directly (fixes non-square pixels from double aspect correction)
- **Quantize UV** node: snaps `gl_FragCoord.xy` to pixel-grid cell centers, outputs frozen-ref UV space coordinates. Wire to noise `coords` for uniform color per cell (chunky pixel look). Connectable `pixelSize` param (2-64).
- Spectra Value FBM preset updated: Quantize UV → Noise.coords for per-cell noise sampling
- Files: modified `pixel-grid.ts`, `bayer-dither.ts`, created `postprocess/quantize-uv.ts`, modified `index.ts`, `test-graph.ts`

**Acceptance test:** All 4 spectra presets (Value FBM, Simplex FBM, Worley Ridged, Box None) reproducible as node graphs. ✅

**Node count after Sprint 4.75:** 18 nodes (down from 20 — merged 4 math nodes into 2)
**Node count after Sprint 5:** 19 nodes (18 + Vec2 Constant; UV Coords modified, not added)
**Node count after Sprint 5.5:** 19 nodes (no new nodes — compiler change + rename only)
**Node count after Sprint 6:** 20 nodes (19 + Color Ramp)
**Node count after Sprint 7:** 22 nodes (20 + Pixel Grid + Bayer Dither)
**Node count after Visual Parity Fix:** 23 nodes (22 + Quantize UV) — **Phase 2 complete**

## Design Tokens

Sombra uses custom CSS variables registered with Tailwind v4's `@theme inline` block in `src/index.css`. Always use the Tailwind utility classes — never inline `style={{}}` for these colors.

| CSS Variable | Tailwind Class | Hex | Usage |
|---|---|---|---|
| `--surface` | `bg-surface` | `#0f0f1a` | App background, canvas |
| `--surface-alt` | `bg-surface-alt` | `#1a1a2e` | Side panels, secondary bg |
| `--surface-raised` | `bg-surface-raised` | `#252538` | Cards, node headers, inputs |
| `--surface-elevated` | `bg-surface-elevated` | `#2d2d44` | Hover states, node body, dropdowns |
| `--fg` | `text-fg` | `#e8e8f0` | Primary text, node titles |
| `--fg-dim` | `text-fg-dim` | `#b8b8c8` | Secondary text, descriptions |
| `--fg-subtle` | `text-fg-subtle` | `#88889a` | Labels, category headers |
| `--fg-muted` | `text-fg-muted` | `#5a5a6e` | Disabled text, IDs, hints |
| `--edge` | `border-edge` | `#3a3a52` | Primary borders, dividers |
| `--edge-subtle` | `border-edge-subtle` | `#2a2a3e` | Subtle borders, node separators |
| `--indigo` | `bg-indigo` / `text-indigo` | `#6366f1` | Accent, selection highlight |
| `--indigo-hover` | `bg-indigo-hover` | `#818cf8` | Accent hover state |
| `--indigo-active` | `bg-indigo-active` | `#4f46e5` | Accent active/pressed state |

All tokens work with any Tailwind color utility prefix: `bg-`, `text-`, `border-`, `ring-`, etc.

**shadcn tokens** (`--background`, `--foreground`, etc.) are separate oklch values used by shadcn/ui primitives. Don't remap Sombra tokens to shadcn tokens.

## Important Layout Notes

The app uses react-resizable-panels for the main layout:
- Outer horizontal group: palette (18%) | center (64%) | properties (18%)
- Center vertical group: node canvas (70%) | shader preview (30%)
- All panels are resizable with min/max constraints
- React Flow requires its parent to have explicit width/height — the panel system provides this
- See [src/App.tsx](src/App.tsx) and [src/components/ui/resizable.tsx](src/components/ui/resizable.tsx)
