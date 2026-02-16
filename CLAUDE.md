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
│   ├── nodes/           # Node type definitions (one file per category or node)
│   ├── compiler/        # Graph-to-GLSL compiler logic
│   ├── stores/          # Zustand stores for app state
│   ├── webgl/           # WebGL renderer (fullscreen quad, offscreen preview)
│   ├── App.tsx          # Root layout component
│   ├── main.tsx         # Entry point
│   └── index.css        # Tailwind imports + dark theme base styles
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
- **Uniforms**: Built-in `u_time`, `u_resolution`, `u_mouse`; user-defined uniforms from node parameters
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

3. **Styling**:
   - Use Tailwind utility classes directly in JSX
   - Base dark theme colors in `src/index.css`
   - React Flow theme customization via CSS variables or inline styles

4. **Testing**:
   - Manual testing via dev server (`npm run dev`)
   - Shader compilation errors logged to console with node IDs
   - Future: Unit tests for compiler, integration tests for rendering

## Deployment

- **GitHub Actions workflow** (`.github/workflows/deploy.yml`) builds on push to `main`
- Outputs `dist/` to `gh-pages` branch
- Site available at `https://spendolas.github.io/sombra/`
- Vite config has `base: '/sombra/'` for correct asset paths

## Phase 0 Status

✅ Scaffold complete
✅ React Flow canvas with dark theme
✅ WebGL2 fullscreen quad renderer with animated gradient
✅ CSS Grid layout (fixed viewport sizing issues)
✅ Layout shell (node palette, canvas, properties panel, preview)
✅ Documentation (CLAUDE.md, ROADMAP.md)
✅ GitHub Pages deployment (auto-deploys on push to main)
✅ Repository set up and deployed to https://spendolas.github.io/sombra/

**Phase 0 Complete!**

## Next Steps (Phase 1)

See `ROADMAP.md` for detailed roadmap. Phase 1 focuses on:
- Core node library (~15 nodes: UV, Time, Noise, Math, Color, Output)
- Graph-to-GLSL compiler
- Live preview with hot-recompile
- Per-node mini-previews
- Parameter editing UI

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
**Phase 1** - Core Editor MVP (in progress)

### Phase 1 Progress

**Step 1: Node System Foundation** - ✅ Complete
- Created core TypeScript interfaces ([src/nodes/types.ts](src/nodes/types.ts))
  - `NodeDefinition`, `PortDefinition`, `NodeParameter`, `GLSLContext`
  - Port types: float, vec2, vec3, vec4, color, sampler2D
- Implemented type coercion system ([src/nodes/type-coercion.ts](src/nodes/type-coercion.ts))
  - Auto-conversion between port types (e.g., float → vec3 broadcast)
  - Compatible type checking for edge connections
- Created node registry ([src/nodes/registry.ts](src/nodes/registry.ts))
  - Singleton registry for all node type definitions
  - Category-based organization

**Step 2: Zustand State Management** - ✅ Complete
- Created graph store ([src/stores/graphStore.ts](src/stores/graphStore.ts))
  - Manages nodes, edges, selection
  - Integrates with React Flow's change handlers
  - CRUD operations for nodes and edges
- Created compiler store ([src/stores/compilerStore.ts](src/stores/compilerStore.ts))
  - Tracks compiled shader code (vertex + fragment)
  - Compilation errors with node-level mapping
  - Compilation status and timing
- Created settings store ([src/stores/settingsStore.ts](src/stores/settingsStore.ts))
  - UI preferences (minimap, grid, snap-to-grid)
  - Preview panel settings
  - Auto-compile configuration
  - Persisted to localStorage

**Step 3: Simple Nodes** - ⏳ Next
**Step 4: Compiler Basics** - ⏳ Pending

## Important Layout Notes

The app uses CSS Grid instead of flexbox for the main layout to ensure React Flow gets explicit dimensions:
- Main grid: 2 rows (header, content) × 3 columns (left panel, center, right panel)
- Center column: nested grid with canvas area + preview (16rem height)
- React Flow requires its parent to have explicit width/height - the grid provides this
- See [src/App.tsx](src/App.tsx) for implementation
