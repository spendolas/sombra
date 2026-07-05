# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Sombra** is a browser-based, node-based shader builder. Users wire visual nodes together on a React Flow canvas to create fragment shaders, with a live fullscreen preview updating in real time. Think Shadertoy meets Blender's shader nodes, in the browser.

**Repository:** `spendolas/sombra` · **Deploy:** GitHub Pages at `spendolas.github.io/sombra` (Vite `base: '/sombra/'`)
**Tech:** Vite, React 19 + TypeScript (strict), @xyflow/react (React Flow v12), Zustand, Tailwind CSS v4, **WebGPU-first rendering with WebGL2 fallback**, GLSL ES 3.0 + WGSL, @dagrejs/dagre for auto-layout, no backend (localStorage + `.sombra` files + shareable URLs).

`AGENTS.md` is the Codex copy of this guide — keep the two in sync when updating project-level guidance.

## Commands

```bash
npm run dev            # Dev server (predev runs check-deps + token generation)
npm run build          # tsc -b && vite build (prebuild same as predev)
npm run lint           # ESLint
npm run preview        # Preview production build

# Design system (Figma → tokens/sombra.ds.json → generated code)
npm run tokens         # Generate index.css marker regions + src/generated/ds.ts + port-colors.ts from DB
npm run tokens:sync    # Pull from Figma REST API + regenerate (main workflow; needs FIGMA_TOKEN in .env)
npm run tokens:check   # CI guard: fail if generated files diverge from DB
npm run tokens:audit   # Figma↔DB parity audit (-- --fix-dry-run to preview patches, -- --strict for CI)
npm run audit:full     # audit:collect + tokens:audit + audit:visual
npm run drift:collect  # / drift:check — token drift detection

# Verification scripts (no test framework — these are the test suite)
npx tsx scripts/verify-ir-poc.ts              # GLSL vs IR-generated output parity (--verbose for full output)
npx tsx scripts/validate-wgsl-multipass.ts    # WGSL GPU compilation tests for all nodes/passes
npx tsx scripts/schema.ts                     # Zod validation of tokens/sombra.ds.json
```

There are no unit tests. Verification = the scripts above + manual testing via dev server + browser automation through `window.__sombra` (see `BROWSER-AUTOMATION.md`).

### Machine setup (Dropbox + multi-arch)

This repo lives in Dropbox and is used from both an Intel Mac Pro (x64) and an Apple Silicon Mac (arm64). `node_modules` must NOT sync between them — native binaries (esbuild, @swc/core, rollup, @tailwindcss/oxide) are arch-specific and break the other machine. On any machine where `node_modules` is missing, was synced from the other arch (symptom: `bad CPU type in executable` / `Cannot find module @rollup/rollup-darwin-*`), or lacks the Dropbox-ignore flag (`xattr -l node_modules` shows nothing):

```bash
rm -rf node_modules && mkdir node_modules
xattr -w com.dropbox.ignored 1 node_modules   # official Dropbox ignore; local-only, set per machine
npm install
```

Note: `npm run check-deps` only hashes package-lock.json — it does not catch wrong-arch node_modules.

## Documentation Map

| File | What it covers |
|---|---|
| `NODE_AUTHORING_GUIDE.md` | **Read before adding/editing nodes.** NodeDefinition reference, GLSL + IR authoring, copy-paste skeleton, pitfalls |
| `BROWSER-AUTOMATION.md` | Full `window.__sombra` dev-bridge API (createNode, connect, compile, describeGraph…) |
| `PHASE6-MULTIPASS.md` | Multi-pass RenderPlan architecture spec (texture boundaries, spatial transforms) |
| `docs/migration/` | WebGPU migration history: `architecture-snapshot.md` (deep module map + data flows), phase reports, agent handoffs |
| `ROADMAP.md` | Phase history and future phases |
| `.figma/IMPLEMENTATION_GUIDE.md`, `.figma/wiki/` | Figma design system structure and component wiki |

## Architecture

### Compile pipeline (runs in a Web Worker)

```
graph (nodes+edges) → topological sort → codegen → RenderPlan → renderer
```

- `src/compiler/compiler.worker.ts` — all codegen runs off-thread; the worker calls `initializeNodeLibrary()` itself. Maps don't survive `postMessage` — serialize to plain objects.
- **Two codegen paths, kept in parity:**
  - `glsl-generator.ts` — legacy string-based GLSL codegen (each node's `glsl(ctx)`)
  - `ir-compiler.ts` + `src/compiler/ir/` — IR-based path (each node's `ir(ctx)`) with `wgsl-backend.ts`/`glsl-backend.ts` and `wgsl-assembler.ts`. This feeds the WebGPU renderer. Worker takes a `useIR` flag and returns both.
- **Multi-pass:** the compiler outputs a `RenderPlan` (ordered `RenderPass[]`), not a single shader. Ports marked `textureInput: true` trigger pass boundaries — upstream renders to a texture, the effect node samples it. Spatial nodes declare `spatial: SpatialConfig` for framework-managed SRT transforms. Single-pass graphs are just a one-pass plan.
- `subgraph-compiler.ts` / `ir-subgraph-compiler.ts` — compile the subgraph up to a target node for per-node preview thumbnails.

### Live update tiers (`use-live-compiler.ts`)

Three change classes, keyed separately, to avoid needless recompiles:
1. **Semantic key** (structure, `updateMode: 'recompile'` params like enums) → debounced worker recompile
2. **Uniform key** (`updateMode: 'uniform'` params — slider drags) → fast path: no recompile, uniform values pushed straight to renderer (WebGL `gl.uniform1f` / WebGPU `queue.writeBuffer`)
3. **Renderer settings** → no recompile, no uniform upload

### Renderer abstraction (`src/renderer/`)

- `types.ts` — `ShaderRenderer` / `PreviewRenderer` interfaces; `CompiledPreview` is an opaque backend-specific union.
- `create-renderer.ts` — factory: tries WebGPU (`src/webgpu/renderer.ts`), falls back to WebGL2 (`src/webgl/renderer.ts`). Preview renderer shares the main renderer's `GPUDevice` when on WebGPU.
- `preview-scheduler.ts` — batches/schedules per-node thumbnail renders (staleness, time-live re-render). Previews use one offscreen context to avoid the browser's WebGL context limit.
- `src/viewer.ts` — standalone no-React viewer: decode URL hash → compile → render (used by `viewer.html` / embed URLs).

**Status:** WebGPU migration complete for both main renderer (167/167 WGSL GPU compilation tests) and preview thumbnails (shared `GPUDevice`, 80×80 render texture, async readback with 512 `bytesPerRow` alignment, LRU pipeline cache). WebGL2 remains the fallback for both and must keep working.

### Node system (41 nodes)

Each node is one file in `src/nodes/<category>/`, registered in `src/nodes/index.ts` `ALL_NODES`. A `NodeDefinition` has typed ports (float, vec2, vec3, vec4, color, sampler2D), params, and **both** a `glsl(ctx)` and an `ir(ctx)` generator — new nodes need both so they work on both backends. Key mechanics (full detail in `NODE_AUTHORING_GUIDE.md`):

- **Connectable params** (`connectable: true`) render as handle + inline slider; always read them via `ctx.inputs.<id>`, never `ctx.params`.
- **Shared functions** via `ctx.addFunction()` (idempotent dedup) — never push to `ctx.functions` directly.
- **`auto_uv` sentinel** on vec2 input defaults — compiler generates frozen-ref UV inline when unconnected.
- **Dynamic ports** via `dynamicInputs`, conditional param visibility via `showWhen`, hidden params via `hidden`.
- **GLSL float literals** must have decimals (`5.0`, not `5`); loops need constant bounds (fixed max + early break).
- Type coercion between port types lives in `src/nodes/type-coercion.ts`; connection validity in `FlowCanvas.tsx` `isValidConnection`.

### Rendering model

- Fullscreen quad (2 triangles), all work in the fragment shader.
- Built-in uniforms: `u_time`, `u_resolution`, `u_mouse`, `u_ref_size`, `u_dpr`, `u_viewport`.
- **Frozen reference sizing:** `u_ref_size` captures `min(width, height)` on first render and never changes; UV math `(v_uv - 0.5) * u_resolution / u_ref_size + 0.5` means resizing reveals/hides edges without zoom or distortion.

### State + UI

- Zustand stores: `graphStore` (nodes/edges/undo-redo, persisted), `compilerStore` (shader output/errors), `settingsStore` (layout/preview mode, persisted), `previewStore` (per-node ImageBitmaps).
- **Preview modes:** docked (vertical/horizontal split), floating (PiP), fullwindow (Esc returns to previous mode). A single `<canvas>` is reparented between target refs via `useEffect` — the effect must depend on both `previewMode` and `splitDirection`. FlowCanvas always stays mounted at the same JSX tree position to prevent viewport jumps.
- Layout: react-resizable-panels — palette (12%) | center | properties (12%); split sizes persisted per direction. Resize handles invisible (`bg-transparent hover:bg-border`). Note: `react-resizable-panels` v4 API differs from shadcn's v3 wrapper — see `resizable.tsx` patch.
- `Cmd+K` command palette for node search.

### Dev bridge (`window.__sombra`)

`main.tsx` calls `installDevBridge()` exposing a programmatic API for browser automation: `createNode()`, `connect()`, `setParams()`, `compile()`, `describeGraph()`, `exportGraph()`, `importGraph()`, `getFragmentShader()`, `validateAllSubgraphWGSL()` (GPU-validates every node's preview WGSL), plus raw store access at `sombra.stores.*`. Use it when testing via the Chrome extension.

## Key Conventions

- TypeScript strict mode everywhere.
- **Tailwind utility classes only** — no per-component CSS, no inline `style={{}}` for Sombra token colors. Exceptions: React Flow props that only accept `style` (may use `var(--surface)` etc.) and runtime-dynamic values like `handleColor`.
- No raw hex values outside `port-colors.ts` and `bg-black` containers.
- Imperative WebGL2/WebGPU — no Three.js or abstraction libraries.
- PascalCase React components, camelCase utilities; one node type per file grouped by category.

## Design System

**Golden Rule: Figma is the source of truth.** All visual additions (color, spacing, size, radius, text style, component) start as a Figma variable/component, flow into the DB, then into generated code:

```
Figma ──(REST API)──► tokens/sombra.ds.json ──(npm run tokens)──► src/index.css marker regions
                        (single source of truth)                   src/generated/ds.ts
                                                                   src/utils/port-colors.ts
```

- Components import `ds` from `@/generated/ds` and use its class strings; only runtime-conditional classes stay inline. If you must add inline visual Tailwind classes, append a migration task to `.claude/ds-queue.md`.
- DB contains colors, portColors, spacing, radius, sizes, textStyles, components (parts → generated Tailwind strings), nodeTemplates, scenes. Schema validated by `scripts/schema.ts` (Zod).
- After manual DB edits: `npm run tokens`. After Figma edits: `npm run tokens:sync`, then `npm run tokens:audit` to verify parity.

### Sombra design tokens (Tailwind classes via `@theme inline`)

| Tailwind class | Hex | Usage |
|---|---|---|
| `bg-surface` | `#0f0f1a` | App background, canvas |
| `bg-surface-alt` | `#1a1a2e` | Side panels |
| `bg-surface-raised` | `#252538` | Cards, node headers, inputs |
| `bg-surface-elevated` | `#2d2d44` | Hover states, node body, dropdowns |
| `text-fg` / `text-fg-dim` / `text-fg-subtle` / `text-fg-muted` | `#e8e8f0` / `#b8b8c8` / `#88889a` / `#5a5a6e` | Text hierarchy |
| `border-edge` / `border-edge-subtle` | `#3a3a52` / `#2a2a3e` | Borders, dividers |
| `border-edge-card` | `oklch(1 0 0 / 10%)` | Node card border |
| `bg-indigo` / `bg-indigo-hover` / `bg-indigo-active` | `#6366f1` / `#818cf8` / `#4f46e5` | Accent states |

All tokens work with any prefix (`bg-`, `text-`, `border-`, `ring-`). **shadcn tokens** (`--background`, `--foreground`, oklch) are separate — used only by shadcn/ui primitives; don't remap between the two systems.

## System-Wide Change Checklist

Non-trivial changes propagate across layers. Check what applies:

- **New node type:** file in `src/nodes/<category>/` with `glsl()` + `ir()`, register in `index.ts`, add to `BROWSER-AUTOMATION.md` node tables, Figma node template, `.figma/wiki/templates/node-templates.md`, node count in CLAUDE.md/ROADMAP.md, test preset in `src/utils/test-graph.ts` if it shows a key capability.
- **New port type:** `src/utils/port-colors.ts` (via DB), `isValidConnection` in `FlowCanvas.tsx`, Figma Port Types variable collection, `BROWSER-AUTOMATION.md` compatibility table.
- **New UI component:** reuse existing DS components first; add entry to `sombra.ds.json` (dsKey, parts with all visual fields, figmaNodeId), `npm run tokens`, wire to `ds.*`; Figma component (atomic hierarchy, variable-bound); wiki page + parity table.
- **New `window.__sombra` method or store shape change:** update `BROWSER-AUTOMATION.md`.
- **New token:** Figma variable collection first, then sync.

## Tips

- Read `ROADMAP.md` before starting a new phase; mimic existing patterns in `src/nodes/` when adding nodes.
- Shader errors are mapped back to node IDs — check console logs.
- `npm run lint` before committing.
- Test WebGL/WebGPU changes in Chrome, Firefox, Safari — shader compilation varies; WebGL2 fallback path must keep working.
- Figma pull uses version-check optimization (`lastFigmaVersion` in DB) — unchanged version exits early.

## Status

Phases 0–5 complete: editor, compiler, 41 nodes, save/load `.sombra` files, compact share URLs, per-node mini-previews, Cmd+K palette, design-system pipeline. **WebGPU migration complete** (main + preview renderers; WebGL2 fallback retained). Recent work: **Phase 6 multi-pass composable effects** (`PHASE6-MULTIPASS.md`) — relay passes for fragColor conflicts, ping-pong aliasing fixes for deep pass chains, 9-point anchor pin on Fragment Output. Sprint-by-sprint history lives in `ROADMAP.md`.
