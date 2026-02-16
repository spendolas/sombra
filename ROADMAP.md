# Sombra Roadmap

## Phase 0 — Scaffold & Proof of Concept

**Goal:** An empty React Flow canvas you can pan around, with a colored fullscreen WebGL quad rendering beside it. Deploys to GitHub Pages.

- [x] Vite + React + TypeScript scaffold
- [x] Install and configure: `@xyflow/react`, `zustand`, `tailwindcss`
- [x] `vite.config.ts` with `base: '/sombra/'`
- [x] Basic `App.tsx` with React Flow canvas (Background, Controls, MiniMap)
- [x] Dark theme base styles (`#0a0a12` background)
- [x] **Fullscreen WebGL quad renderer** — a raw WebGL2 canvas that renders a simple passthrough fragment shader (solid color or gradient). Proves the WebGL pipeline works before connecting it to the node graph. Renders beside or behind the React Flow canvas.
- [x] **Layout shell** — node canvas (center), placeholder for properties panel (right), placeholder for node palette (left)
- [ ] **GitHub Pages deploy** — GitHub Actions workflow that builds and pushes `dist/` to `gh-pages` branch
- [x] Write `CLAUDE.md` (project instructions for future sessions)
- [x] Write `ROADMAP.md` (this roadmap, standalone file in the repo)
- [ ] Git init, initial commit, push to `spendolas/sombra`

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

### Live Preview

- [x] Fullscreen quad renders the compiled fragment shader
- [x] Hot-recompile on every graph change (debounced ~100ms)
- [ ] Per-node mini-preview via single offscreen WebGL context (captures to `<img>`) — **Moved to Phase 2 backlog**
- [ ] Split view (editor + preview) and fullscreen preview toggle — **Moved to Phase 2 backlog**

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

## Phase 2 — Save/Load/Export

- localStorage auto-save with schema versioning
- JSON download/upload for sharing graph files
- "Copy GLSL" button — exports the compiled fragment shader
- Embed HTML snippet generator
- `/embed.html?material=<base64>` shareable URLs (still static, no backend)

**Milestone:** Save your work, share a link, copy the shader code.

---

## Phase 3 — Node Library Expansion (~40 nodes)

- **Noise:** Worley, FBM, Turbulence, Ridged, Box
- **Patterns:** Checkerboard, Stripes, Dots, Voronoi
- **Distortion:** Domain Warp, Rotate/Scale/Offset UV, Polar Coordinates
- **More Math/Vector/Color nodes** as needed
- **Subgraphs:** Group nodes into reusable compound nodes
- **Custom GLSL Node:** Paste arbitrary GLSL with user-defined ports
- **Shadertoy/GLSL Sandbox import adapters**
- Cmd+K node search palette
- Undo/redo, keyboard shortcuts

**Milestone:** Rich enough node library to recreate complex shaders entirely in the editor.

---

## Phase 4 — Polish & Performance

- Final visual design (Figma-driven), dark/light themes, responsive layout
- Lazy compilation, FPS throttling, React Flow virtualization for large graphs
- **"Spectra Mode"** — reproduce all 4 spectra-pixel-bg presets as node graphs (these become built-in example materials)
- Example materials library, onboarding flow / tutorial

**Milestone:** Polished, performant, with built-in examples that showcase what's possible.

---

## Phase 5 — Future (Trigger-Based, Not Scheduled)

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

spectra-pixel-bg continues to power spendolas.com unchanged. The 4 spectra presets (Value FBM, Simplex FBM, Worley Ridged, Box None) and 6 palettes become built-in example materials in sombra's Phase 4 "Spectra Mode." Eventually spendolas.com could embed a sombra-built material directly.
