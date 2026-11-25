# Sombra

A browser-based, node-based shader builder. Wire visual nodes together on a canvas to build fragment shaders, with a live preview that updates as you edit.

**Think Shadertoy meets Blender's shader nodes, in the browser.** Live at [sombra.sh](https://sombra.sh).

## Features

- **46 nodes** across input, math, noise, pattern, color, vector, distort, effect, transform, postprocess and output categories, including a multi-layer Stack compositing node with 24 blend modes.
- **WebGPU first, WebGL2 fallback.** Each node generates both WGSL/GLSL so both backends render the same graph.
- **Multi-pass rendering.** Effects such as blur sample upstream results through texture boundaries in an ordered render plan.
- **Live compilation off the main thread.** Slider drags update uniforms directly with no recompile.
- **Per-node previews**, a Cmd+K node search palette, auto-layout, and undo/redo.
- **Save, load and share.** `.sombra` files (with an embedded preview thumbnail and the build that wrote them), compact shareable viewer URLs, and localStorage persistence. There is no backend.
- **Export** images and video from the editor.
- **Shader embed.** Publish a compiled shader and drop it on any site with a copy-paste snippet and a small standalone player. See [EMBED.md](EMBED.md).

## Tech Stack

- **Vite**, **React 19** and strict **TypeScript**
- **@xyflow/react** (React Flow v12) for the node canvas
- **Zustand** for state
- **Tailwind CSS v4** with a Figma-driven design-token pipeline
- **WebGPU / WGSL** and **WebGL2 / GLSL ES 3.0**, written imperatively with no graphics library

## Development

```bash
npm install       # Install dependencies
npm run dev       # Start dev server
npm run build     # Typecheck + production build (includes the embed player)
npm run lint      # Run linter
npm run verify:ci # Compiler and codegen verification suite
```

There is no unit-test framework: the `verify:*` scripts are the test suite (see `package.json`). See [CLAUDE.md](CLAUDE.md) for the full command list, architecture and project guardrails.

## Deployment

Deployed to GitHub Pages at [sombra.sh](https://sombra.sh). Pull requests are checked by CI, and pushes to `main` run the same verification before deploying.

## Documentation

- [CLAUDE.md](CLAUDE.md): architecture, commands and conventions
- [NODE_AUTHORING_GUIDE.md](NODE_AUTHORING_GUIDE.md): how to add or edit nodes
- [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md): the `window.__sombra` dev bridge
- [PHASE6-MULTIPASS.md](PHASE6-MULTIPASS.md): multi-pass render plan design
- [EMBED.md](EMBED.md): shader embed player
- [ROADMAP.md](ROADMAP.md): phase history and future work
