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
- **Tailwind utility classes only** - no per-component CSS files
- **Dark theme** - base background `#0a0a12`, gray palette for UI
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
- **Type** (e.g., `simplex_noise`, `mix`, `uv_coords`)
- **Inputs/Outputs** with typed ports (float, vec2, vec3, vec4, color, sampler2D)
- **Parameters** with default values
- **GLSL generator function** - emits GLSL code snippet given inputs/outputs/params
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
   - Use Tailwind utility classes directly in JSX
   - Base dark theme colors in `src/index.css`
   - React Flow theme customization via CSS variables or inline styles

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

## Next Steps (Phase 2)

See `ROADMAP.md` for the full Phase 2 brief. Focus: Spectra Mode + UX Polish
- Shared GLSL function deduplication + enum parameter type
- 8 noise nodes: Value 3D, Simplex 3D, Worley, Box, FBM, Turbulence, Ridged, Domain Warp
- 4 UV/input nodes: Rotate UV, Scale UV, Offset UV, Vec2 Constant
- Color Ramp node with interactive gradient editor + 6 spectra palette presets
- Pixel Grid + Bayer Dither nodes for pixel-art rendering
- Connection UX: colored edges, reconnectable, delete-on-drop, proximity connect, single-wire swap, port status visuals

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
**Phase 2** - 🔜 Next (Spectra Mode + UX Polish)

### Phase 2 — Spectra Mode + UX Polish

Replicate the full spectra-pixel-bg experience as composable node-graph features, plus connection UX polish. See `ROADMAP.md` for the full brief with sprint breakdown.

**Key deliverables:**
- 15 new nodes (30 total): 8 noise (Value 3D, Simplex 3D upgrade, Worley, Box, FBM, Turbulence, Ridged, Domain Warp), 4 UV/input (Rotate, Scale, Offset, Vec2 Constant), Color Ramp, Pixel Grid, Bayer Dither
- Compiler: shared GLSL function deduplication (`functionRegistry` on `GLSLContext`), enum parameter type
- UX: connector color coding by port type, reconnectable edges, delete-on-drop, proximity connect, single-wire-per-input swap, connected/unconnected port visual distinction

**Sprint order:** Infrastructure+UX → Noise Primitives → Fractal+Warp → UV/Input → Color Ramp → Pixel Rendering

**Acceptance test:** Manually wire node graphs that reproduce all 4 spectra presets (Value FBM, Simplex FBM, Worley Ridged, Box None).

## Important Layout Notes

The app uses react-resizable-panels for the main layout:
- Outer horizontal group: palette (18%) | center (64%) | properties (18%)
- Center vertical group: node canvas (70%) | shader preview (30%)
- All panels are resizable with min/max constraints
- React Flow requires its parent to have explicit width/height — the panel system provides this
- See [src/App.tsx](src/App.tsx) and [src/components/ui/resizable.tsx](src/components/ui/resizable.tsx)
