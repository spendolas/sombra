# Sombra

A browser-based, node-based WebGL shader builder. Wire visual nodes together to create fragment shaders with live preview.

**Think Shadertoy meets Blender's shader nodes, in the browser.**

## Tech Stack

- **Vite** - Fast build tooling
- **React 19 + TypeScript** - UI framework with strict typing
- **@xyflow/react** - Node editor canvas
- **Zustand** - Lightweight state management
- **Tailwind CSS v4** - Utility-first styling
- **WebGL2** - Raw graphics API for shader rendering
- **GLSL ES 3.0** - Modern shader language

## Development

```bash
npm install       # Install dependencies
npm run dev       # Start dev server
npm run build     # Production build
npm run lint      # Run linter
```

## Deployment

Deployed to GitHub Pages at: [spendolas.github.io/sombra](https://spendolas.github.io/sombra)

Builds automatically on push to `main` via GitHub Actions.

## Project Status

✅ **Phase 0** - Scaffold & Proof of Concept (Complete)
🚧 **Phase 1** - Core Editor MVP (In Progress)

See [ROADMAP.md](ROADMAP.md) for detailed development plan.
See [CLAUDE.md](CLAUDE.md) for project documentation and architecture details.
