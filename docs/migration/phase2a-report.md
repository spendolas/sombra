# Phase 2a Report: WebGPU Renderer (Single-Pass)

## Summary

Phase 2a stands up the WebGPU renderer for single-pass shader graphs. The implementation includes a WGSL shader assembler, an IR-based compilation path, a WebGPU renderer backend, and compiler worker integration. Multi-pass graphs automatically fall back to WebGL2.

## New Files

| File | Purpose |
|------|---------|
| `src/compiler/ir/wgsl-assembler.ts` | IR → complete WGSL program (vertex + fragment, uniform buffer struct) |
| `src/compiler/ir-compiler.ts` | IR compilation path — mirrors glsl-generator but calls `ir()` on each node |
| `src/webgpu/renderer.ts` | `WebGPUShaderRenderer` implementing `ShaderRenderer` interface |

## Modified Files

| File | Change |
|------|--------|
| `src/compiler/glsl-generator.ts` | Added `wgsl?` field to `RenderPlan` interface |
| `src/compiler/compiler.worker.ts` | Added `useIR` flag + IR compilation call in worker |
| `src/compiler/use-live-compiler.ts` | Added `useIR` parameter, forwarded `wgsl` data in compile callback |
| `src/renderer/create-renderer.ts` | Factory now accepts `preferWebGPU` option, tries WebGPU first |
| `src/viewer.ts` | Uses IR compiler + WebGPU renderer when available |
| `src/App.tsx` | Passes `preferWebGPU: true` to factory, `useIR` to compiler, forwards `wgsl` data |
| `tsconfig.json` | Added `@webgpu/types` to `types` array |
| `package.json` | Added `@webgpu/types` devDependency |

## Design Decisions

### 1. WGSL Assembler: Uniform Buffer Layout

The assembler computes a byte-aligned uniform buffer struct following WGSL alignment rules:
- `f32`: 4-byte size, 4-byte align
- `vec2f`: 8-byte size, 8-byte align
- `vec3f`: 12-byte size, 16-byte align (!)
- `vec4f`: 16-byte size, 16-byte align

Padding `_padN: f32` fields are automatically inserted between fields where alignment requires it. Total buffer size is rounded up to 16-byte boundary.

Built-in uniforms use a fixed order: `u_time`, `u_resolution`, `u_dpr`, `u_ref_size`, `u_viewport`. User uniforms are appended after.

### 2. Uniform Name Rewriting

Per-node WGSL code uses bare uniform names (`u_time`, `u_resolution`). The assembler performs a post-pass regex rewrite: `\bu_NAME\b` → `uniforms.u_NAME`. This keeps the WGSL backend simple and avoids leaking struct member syntax into individual node IR functions.

The regex uses a negative lookbehind for `[.\w]` to avoid rewriting local variables that happen to contain uniform-like substrings (e.g., `node_abc_value` won't be rewritten even though it contains characters matching uniform patterns).

### 3. gl_FragCoord → in.position

WGSL fragment shaders receive position via `@builtin(position)` on the input struct. The assembler rewrites `gl_FragCoord` → `in.position` in the assembled code.

**Y-axis difference**: WebGPU's `@builtin(position).y` increases top-to-bottom, matching the fragment coordinate convention. The `auto_uv` default in GLSL does `u_resolution.y - gl_FragCoord.y` to flip Y, but the WGSL version omits this flip. This is handled in `ir-compiler.ts`'s `resolveInputDefaultIR()` using a `raw()` IR node with explicit GLSL and WGSL variants.

### 4. IR Compiler as Separate File

`ir-compiler.ts` mirrors `glsl-generator.ts`'s structure but calls `ir()` instead of `glsl()`. Key shared utilities (`uniformName`, `paramGlslType`, `formatDefaultValue`, `partitionPasses`) are imported from the GLSL generator. This avoids polluting the existing GLSL path.

The IR compiler returns `null` for multi-pass graphs (detected via `partitionPasses`), triggering automatic fallback to GLSL/WebGL2.

### 5. No Dual-Canvas in Phase 2a

A single renderer is created from the factory. When WebGPU is preferred and available, the WebGPU renderer is created. Multi-pass graphs that arrive with no `plan.wgsl` field cause the WebGPU renderer's `updateRenderPlan()` to return `{ success: false }`, which the app handles by clearing the canvas.

Phase 2b will address the dual-backend hot-swap for seamless multi-pass fallback.

### 6. Pipeline Caching

The WebGPU renderer caches pipelines by a simple hash of the WGSL source string. LRU eviction at 32 entries (same as the WebGL2 program cache). Since WGSL pipelines don't have a `destroy()` method, dropping references from the cache is sufficient for GC.

### 7. Image Textures

Image upload uses `createImageBitmap` with `imageOrientation: 'flipY'` for Y-flip (WebGPU textures have top-left origin). Texture and sampler are created as separate objects and stored per sampler name. Bind group 1 is rebuilt when textures change.

## Verification Results

- [x] `tsc --noEmit` — clean, no errors
- [x] `npm run build` — clean, production build succeeds
- [ ] Visual rendering — requires browser testing (WebGPU-capable browser)
- [ ] Uniform fast path — requires browser testing
- [ ] Pipeline cache — requires browser testing
- [ ] Device lost recovery — requires browser testing
- [ ] Image textures — requires browser testing

## Recommendations for Phase 2b

1. **Multi-pass on WebGPU**: Need intermediate render textures (FBOs equivalent) and multi-pass pipeline management. The WGSL assembler may need pass-specific assembly.
2. **Dual-backend hot-swap**: When a graph transitions between single-pass and multi-pass, swap between WebGPU and WebGL2 seamlessly. Consider overlaid canvases or context recreation.
3. **Preview thumbnails on WebGPU**: The offscreen preview renderer (`PreviewRenderer`) currently stays on WebGL2. Porting it to WebGPU would unify the rendering pipeline.
4. **Async pipeline creation**: Use `createRenderPipelineAsync` for non-blocking compilation. The current implementation uses synchronous `createRenderPipeline` for simplicity.
5. **Visual regression testing**: Capture per-pixel comparison data between WebGL2 and WebGPU backends for 5 representative graphs.
