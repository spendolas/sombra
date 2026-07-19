# Shader Embed on Third-Party Pages — Design Spec

**Date:** 2026-07-19
**Status:** Draft for review
**Feature:** Let a Sombra user publish a finished shader and embed it on any third-party website, via (1) a copy-paste out-of-the-box snippet and (2) a JS toolkit exposing every shader knob to the host page.
**Primary criteria:** runtime performance, portability / modularity of the architecture.

---

## 1. Goals & non-goals

### Goals
- **Mode 1 — copy-paste:** a self-contained snippet a non-developer pastes into their page; the shader renders, animated, with no build step.
- **Mode 2 — toolkit:** a JS API that mounts the shader and exposes all its knobs (uniform params) to the host page for live control.
- Ship a **frozen** embed: the graph is compiled once at publish time; the embed carries baked shader code + a knob manifest and contains **no compiler and no nodes registry**.
- Inherit Sombra's **WebGPU-first, WebGL2-fallback** rendering unchanged.
- Keep the player bundle small and modular; walled off from the editor.

### Non-goals (this release)
- **Live/structural editing in the embed** — the embed cannot rewire nodes or change graph structure, only tweak exposed knobs. The artifact format reserves a `kind` field so a future `kind:'live'` build can carry the graph, but that build is out of scope now.
- **Pointer/mouse interactivity** — Sombra has no `u_mouse` uniform or pointer node today. Deferred to v2. The toolkit API reserves the setter shape.
- **Sombra-hosted per-user scene artifacts** — there is no backend. The scene payload travels **inline in the snippet** (see §4). A user-self-hosted scene file is a possible v2 addition, not built now.
- **Shared/offscreen GPU context across many embeds** — v1 uses one context per embed, gated by IntersectionObserver. Shared-context is a v2 optimization (see §8).

### Key product decisions (locked during brainstorming)
1. **Mutability:** frozen graph, knobs-only, with the artifact format designed so a future live build can reuse it.
2. **Runtime hosting:** the player JS loads from the Sombra CDN (GitHub Pages, `spendolas.github.io/sombra`), version-pinned. Not self-hosted by default.
3. **Payload delivery:** the compiled scene payload is **inline in the snippet**. No user upload, no account.
4. **Interactivity:** time-animation + host-controlled knobs in v1; pointer deferred to v2.

---

## 2. Background — what already exists (repo facts)

These are the foundations the design builds on; verified against the current codebase.

- **Standalone viewer** (`src/viewer.ts`, `viewer.html`) already renders a graph with **no React/xyflow** — it decodes a URL hash, calls `initializeNodeLibrary()`, `compileGraph()` (+ `compileGraphIR()` when `navigator.gpu`), `createShaderRenderer(canvas)`, `updateRenderPlan`, uploads baked uniforms + images, and drives the loop. The embed is essentially the viewer minus the compiler, packaged as a library.
- **Compile output** — `compileGraph(nodes, edges): RenderPlan` (`src/compiler/glsl-generator.ts:629`, synchronous, main-thread) and `compileGraphIR(nodes, edges): WGSLMultiPassOutput | null` (`src/compiler/ir-compiler.ts:444`). The viewer attaches the WGSL passes onto `result.wgsl`. `RenderPlan` holds **both** GLSL passes and WGSL passes, so a single artifact can serve both backends.
- **Knob metadata is free** — `RenderPlan.userUniforms: UniformSpec[]` where `UniformSpec = { name, glslType, value, nodeId, paramId }` (`src/nodes/types.ts:338`). One entry per unwired `updateMode:'uniform'` param on an active node. Static metadata (label, type, min, max, step, enum options, `updateMode`) lives on `NodeDefinition.params: NodeParameter[]`.
- **Runtime uniform fast-path** — `renderer.updateUniforms([{ name, value }])` (`src/renderer/types.ts`) pushes straight to `gl.uniform*` / `queue.writeBuffer` with **no recompile**. This is the mechanism behind every host knob change.
- **Renderer factory** — `createShaderRenderer(canvas): Promise<ShaderRenderer>` (`src/renderer/create-renderer.ts:19`) tries WebGPU then WebGL2, dynamically `import()`-ing the chosen backend. `ShaderRenderer` exposes `updateRenderPlan`, `updateUniforms`, `uploadImageTexture`, `render`, `startAnimation`/`stopAnimation`, `setAnimated`, `setAnimationSpeed`, `setQualityTier`, `setAnchor`, `onDeviceLost`, `dispose`, and `readonly backend`.
- **Built-in uniforms** are set every frame by the renderer: `u_time`, `u_resolution`, `u_dpr`, `u_ref_size` (constant `REFERENCE_SIZE = 512`), `u_viewport`, `u_anchor`. There is **no `u_mouse`**.
- **Vertex shader is a constant** — `VERTEX_SHADER` (`src/compiler/glsl-generator.ts:102`), identical for every graph; the WGSL renderer has its own constant vertex stage. It is duplicated into every pass of every `RenderPlan` today.
- **Serialization primitives** — `src/utils/sombra-file.ts` provides pako-deflate + base64url helpers (`toBase64Url`, chunked to avoid `String.fromCharCode` RangeError) and the compact graph codec. The embed reuses the compression/encoding primitives but defines its **own artifact schema** (compiled output, not the node graph).
- **Images** are stored as base64 data URLs in `params.imageData` (stripped from localStorage but present in the in-memory graph). Sampler name = `u_${nodeId.replace(/-/g,'_')}_image`. Uploaded at render time via `renderer.uploadImageTexture(samplerName, HTMLImageElement)`.
- **Build** — `vite.config.ts` is a multi-page app (`index.html`, `viewer.html`, `ds-preview.html`) with `base: '/sombra/'`. There is **no library/UMD build target today** — the player build is net-new.

---

## 3. Architecture overview

Three layers:

1. **Scene Artifact** (new serialization) — a frozen, self-contained description of a compiled scene: fragment shaders for both backends, a knob manifest, baked images, and render metadata. Produced in the editor at publish; consumed by the player. Contains no node graph.
2. **Player runtime** (new build target) — a standalone UMD + ESM bundle: artifact decoder + renderer wrapper + performance harness. **Zero React, xyflow, compiler, or nodes registry.** Reuses `create-renderer.ts` verbatim, inheriting the WebGPU/WebGL2 fallback.
3. **Two front doors** over the same player:
   - **Mode 1 (copy-paste):** self-bootstrapping UMD loader + `<div data-sombra-scene="…">`; the player auto-scans the DOM, injects a canvas, and mounts.
   - **Mode 2 (toolkit):** `Sombra.mount(el, opts)` → a `SceneHandle` with enumerable, typed knob setters that route through the uniform fast-path.

**Delivery mechanism decision:** **script + mount is primary** (max host control of knobs, lowest GPU overhead, keeps the GPU context in the host document so the ~16-context budget can be honored). An **iframe snippet is an explicit fallback** for hostile-CSP / untrusted contexts, reusing `viewer.html`. A **Web Component is deliberately not the primary** delivery — the global `customElements` registry collides when two Sombra versions load on one page and can crash the host; if offered later it must guard `customElements.get()` and allow a consumer tag prefix.

```
EDITOR (publish)                          HOST PAGE (embed)
────────────────                          ─────────────────
graph                                     <script> loads UMD player (CDN, pinned)
  │ compileGraph + compileGraphIR           │ auto-init scans [data-sombra-scene]
  ▼                                          ▼
RenderPlan (GLSL + WGSL passes)           decodeArtifact
  │ buildManifest(plan)                      │ reconstruct RenderPlan (+ vertex constant)
  ▼                                          ▼
KnobDescriptor[]                          createShaderRenderer(canvas)
  │ encodeArtifact                           │ updateRenderPlan
  ▼                                          │ updateUniforms(baked values) + upload images
SceneArtifact → base64url                   ▼
  │ snippet templates                      perf-harness starts IO-gated loop
  ▼                                          ▲
copy-paste / developer / iframe           handle.set('key', v) → uniform fast-path
```

---

## 4. Scene Artifact (serialization)

### Schema

```ts
// src/embed/artifact.ts
interface SceneArtifact {
  v: 1                         // artifact schema version
  kind: 'frozen'               // reserved: future 'live'
  backend: {
    // fragment-only; vertex stage is the player's built-in constant, never serialized
    glsl: PassArtifact[]       // WebGL2 passes
    wgsl: PassArtifact[]       // WebGPU passes
  }
  manifest: KnobDescriptor[]   // exposed knobs
  images: ImageAsset[]         // baked textures (base64), sampler names
  meta: {
    isAnimated: boolean
    timeSpeed: number
    anchor: [number, number]
    qualityTier: 'adaptive' | 'low' | 'medium' | 'high'
  }
}

interface PassArtifact {
  index: number
  frag: string                 // fragment source ONLY
  userUniforms: { name: string; value: number | number[] }[]  // baked defaults
  inputTextures: Record<string, number>   // samplerName → source pass index
  isTimeLive: boolean
  textureFilter?: 'linear' | 'nearest'
}

interface KnobDescriptor {
  key: string                  // friendly, deduped (e.g. "scale", "scale-2")
  uniform: string              // wire name, e.g. "u_abc123_scale"
  label: string
  type: 'float' | 'vec2' | 'vec3' | 'color' | 'enum' | 'bool'
  min?: number
  max?: number
  step?: number
  default: number | number[]
  options?: { label: string; value: number }[]  // enum
}

interface ImageAsset {
  sampler: string              // "u_<sanitizedNodeId>_image"
  dataUrl: string              // base64 data URL (possibly re-encoded/downscaled)
}
```

### Encoding
`encodeArtifact(a): string` — `JSON.stringify` → `pako.deflate` → base64url (reuse the chunked `toBase64Url` primitive). `decodeArtifact(s): SceneArtifact` — inverse.

`decodeArtifact` reconstructs a `RenderPlan` the renderer accepts, pairing each `PassArtifact.frag` with the **built-in vertex constant** the player owns. It fills `vertexShader` per pass and rebuilds the top-level backward-compat fields the renderer expects.

### Size strategy (in priority order)
1. **Deflate carries it** — generated GLSL/WGSL is highly redundant; pako typically achieves 5–8× on shader text, so shipping both backends inline is cheap after compression.
2. **Omit the vertex shader** — it is the constant `VERTEX_SHADER`; the player owns the one copy and pairs it in at decode. Also drop `RenderPlan`'s duplicate top-level `fragmentShader`/`vertexShader`/`userUniforms` (keep per-pass only). The invariant "player vertex constant == compiler `VERTEX_SHADER`" is asserted in the round-trip verification.
3. **Identifier minification (deferred)** — renaming generated local variables to short tokens shrinks pre-deflate; uniform names are the manifest↔renderer ABI and must be renamed in lockstep or left alone. Marginal after deflate → a later hook, not built in v1.
4. **base64url stays** — the only ASCII form safe inside an HTML attribute; the ~33% overhead is accepted.
5. **Images dominate** — deflate cannot shrink already-compressed image bytes. Publish UI shows payload size, warns past a threshold, and offers **WebP re-encode + max-dimension downscale** at publish. (This is the case the deferred file-host option targets; inline + downscale is the v1 answer.)

Net: pure-shader scenes are single-digit KB; image scenes are dominated by the image, mitigated by re-encode/downscale.

---

## 5. Modules & file layout

All new code under `src/embed/`, walled off so the player bundle stays lean.

**Shared (pure, no DOM):**
- `src/embed/artifact.ts` — `SceneArtifact` type + `encodeArtifact` / `decodeArtifact`. Decode reconstructs `RenderPlan` with the built-in vertex constant.
- `src/embed/manifest.ts` — `buildManifest(plan, nodeDefs): KnobDescriptor[]`. Joins `plan.userUniforms[]` with `NodeDefinition` param metadata. `key` = slugified label, deduped. Pure.
- `src/embed/vertex.ts` — the built-in vertex constant(s) (GLSL + WGSL), the single source of truth shared with the compiler via `src/renderer/constants.ts` / `glsl-generator`'s `VERTEX_SHADER`.

**Editor-side (publish):**
- `src/embed/publish.ts` — orchestrates compile → `buildManifest` → optional image re-encode/downscale → `encodeArtifact` → snippet-template strings (copy-paste, developer, iframe).
- `src/components/EmbedModal.tsx` — three-tab UI (Copy-paste, Developer, Advanced/iframe), live preview, payload-size badge, image-downscale toggle. Triggered by a new **Embed** button in `src/components/GraphToolbar.tsx`.

**Player runtime (zero React/xyflow/compiler/nodes):**
- `src/embed/player.ts` — `mount(el, opts): SceneHandle`. Wraps `createShaderRenderer`, `updateRenderPlan`, drives the loop, owns the perf harness.
- `src/embed/perf-harness.ts` — IntersectionObserver pause, `visibilitychange` pause, `prefers-reduced-motion` static frame, DPR clamp `min(dpr,2)`, context-loss re-init via `onDeviceLost`.
- `src/embed/auto-init.ts` — scans `[data-sombra-scene]`, injects a canvas, calls `mount`; idempotent (marks mounted elements).
- `src/embed/index.ts` — public entry: `{ mount, init, version }`; UMD global `Sombra` + ESM export; runs auto-init as a side effect on load.

**Build:**
- `vite.embed.config.ts` — library build (`build.lib`, UMD + ESM) → `dist/embed/sombra-player.<version>.umd.js` and `.esm.js`. `pako` bundled; renderer backends stay dynamic-imported (feature-detect → load one). Added as a second pass in `npm run build`.

---

## 6. Toolkit API (Mode 2)

```ts
// UMD global `Sombra` or ESM import
interface MountOptions {
  scene: string                // base64url artifact (or read from data-attr)
  variables?: Record<string, number | number[]>  // initial knob overrides
  autoplay?: boolean           // default true
  debug?: boolean              // show inline error labels
  onLoad?: (h: SceneHandle) => void
  onError?: (e: Error) => void
}

interface SceneHandle {
  set(key: string, value: number | number[]): void   // → uniform fast-path
  get(key: string): number | number[] | undefined
  variables(): KnobDescriptor[]   // enumerable + typed → host can auto-build a UI
  play(): void
  pause(): void
  resize(): void
  destroy(): void
  on(event: 'load' | 'error' | 'contextlost', cb: (...a: any[]) => void): void
  // reserved for v2: pointer(x, y)
}

function mount(el: HTMLElement, opts: MountOptions): SceneHandle
function init(): void          // manual re-scan of [data-sombra-scene]
const version: string
```

- `set()` maps `key` → `uniform` via the manifest and calls `renderer.updateUniforms([{name, value}])`. No recompile. Unknown key → warn (listing valid keys) and ignore; never throws into host code.
- `variables()` returns the typed, enumerable manifest so a host can generate a control panel automatically (the Rive/Spline pattern).
- Naming follows mature runtimes: single options-object constructor, lifecycle callbacks, reactive setters.

### Snippets emitted by publish

**Mode 1 — copy-paste** (self-bootstrapping loader, Unicorn pattern):
```html
<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");
i.src="https://spendolas.github.io/sombra/embed/sombra-player.<version>.umd.js";
i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>
<div data-sombra-scene="<base64url-artifact>" style="width:100%;aspect-ratio:16/9"></div>
```

**Mode 2 — developer:**
```html
<script src="https://spendolas.github.io/sombra/embed/sombra-player.<version>.umd.js"></script>
<div id="my-shader" style="width:100%;aspect-ratio:16/9"></div>
<script>
  const h = Sombra.mount(document.getElementById('my-shader'), { scene: "<base64url-artifact>" });
  // auto-generated from the manifest:
  h.set('intensity', 0.65);   // float, 0–1
  h.set('accent', [0.4,0.4,0.95]);  // color
</script>
```

**Advanced — iframe fallback** (hostile CSP; reuses `viewer.html` with a ResizeObserver→postMessage auto-height handshake, origin-validated):
```html
<iframe src="https://spendolas.github.io/sombra/viewer.html#g=<hash>" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>
```

- CDN URLs are **version-pinned**; publish emits an exact-pinned + SRI variant as the "secure" option and a major-pinned variant as the "auto-patch" option.

---

## 7. Publish flow (editor UX)

New **Embed** action in `GraphToolbar` beside the share-URL button. On open, the Embed modal:
1. compiles the current graph (`compileGraph` + `compileGraphIR`, same calls as the viewer),
2. builds the knob manifest (`buildManifest`),
3. optionally re-encodes/downscales baked images,
4. assembles + encodes the artifact,
5. renders three tabs:
   - **Copy-paste** — the self-bootstrapping snippet, one Copy button, a live preview of the actual player rendering, a payload-size badge (image warning + downscale toggle).
   - **Developer** — the `Sombra.mount` code + an auto-generated knob table (key, type, range, ready `handle.set(...)` example). **v1 exposes all uniform knobs with auto keys; per-knob rename/hide is a fast-follow.**
   - **Advanced** — collapsed iframe fallback + SRI/pinning options.

End-to-end: *open shader → click Embed → pick tab → Copy → paste.* No save, no account, no upload.

---

## 8. Performance harness (built into the player)

Every mounted scene ships these defaults:
- **IntersectionObserver-gated rAF loop** (`rootMargin` warm-up) — offscreen embeds hold no live loop.
- **`visibilitychange` pause** — free GPU resources when the tab is hidden.
- **`prefers-reduced-motion`** — render a single static frame; subscribe to changes.
- **DPR clamp** — `Math.min(devicePixelRatio, 2)`, re-checked on resize; builds on existing `u_dpr` plumbing.
- **Context-loss / `device.lost` handling** — reuse `renderer.onDeviceLost`; tear down the loop and re-run init.
- **WebGPU init discipline** — feature-detect `navigator.gpu` up front (no canvas), handle `requestAdapter()` resolving `null` and `requestDevice()` rejecting, HTTPS-only, then choose the backend before creating the canvas context (contexts are mutually exclusive per canvas). All already handled by `create-renderer.ts`; the harness must not regress it.

**Multi-embed context ceiling (~16 Chrome / 8 Firefox desktop / 2 Firefox mobile):** v1 relies on IntersectionObserver gating (offscreen embeds idle). **Shared-offscreen-context across embeds is a v2 optimization** — flagged here, not built.

---

## 9. Error handling

The player runs on someone else's page and must fail quietly, never taking down the host:
- **Decode failure** → `console.error("[Sombra] …")`, render nothing, host DOM untouched; inline error label only if `opts.debug`.
- **No WebGPU and no WebGL2** → one warning + static fallback paint, not a crash.
- **Context loss** → first-class re-init path via `onDeviceLost`.
- **Bad knob key/value** → warn + ignore; never throw into host code.
- **SSR / no-DOM / invalid element** → `mount` guards and returns a no-op handle.
- **Double-init** → `auto-init` marks mounted elements; `Sombra.init()` is idempotent.
- **iframe path** → `postMessage` always origin-validated (never `'*'`); sandbox never combines `allow-scripts` + `allow-same-origin` on untrusted content.

---

## 10. Verification (no test framework — extend the tsx-script suite)

1. `scripts/verify-artifact-roundtrip.ts` — encode→decode parity across representative graphs (single-pass, multi-pass, image-bearing, animated). Assert the reconstructed `RenderPlan` matches the original except the intentionally-omitted vertex field, and assert the player's built-in vertex constant equals the compiler's `VERTEX_SHADER`.
2. `scripts/verify-manifest.ts` — every unwired `updateMode:'uniform'` param surfaces exactly one `KnobDescriptor`; keys unique/deduped; types/ranges match `NodeDefinition`.
3. **Reuse** `scripts/validate-wgsl-multipass.ts` against artifact-reconstructed plans — the frozen shaders still GPU-compile.
4. **Browser smoke** (dev-bridge pattern) — load the built player + an artifact in a headless Chrome tab, assert non-blank pixels, then `handle.set(...)` a knob and assert the frame changes. Document in `BROWSER-AUTOMATION.md`.
5. **Bundle-size gate** — grep `dist/embed/sombra-player.umd.js` to assert no React/xyflow/compiler/nodes are bundled; enforce a KB budget; fail the build on regression.

---

## 11. Optional side-task (separate, non-blocking)

**Attribute-less fullscreen triangle** in both core renderers (WebGL2 + WebGPU): drop the quad vertex buffer/attribute (`a_position`) and generate geometry from the vertex index (one oversized triangle). Removes a GPU buffer allocation and the attribute wiring; marginally faster (no diagonal seam/overdraw). Affects editor, viewer, and previews — not the embed payload (already vertex-free). Its own verification; does not gate the embed work.

---

## 12. Docs to update (System-Wide Change Checklist)

- `BROWSER-AUTOMATION.md` — player API + smoke method.
- `CLAUDE.md` / `AGENTS.md` — new `src/embed/` layer + player build target.
- `ROADMAP.md` — embed phase.
- New `EMBED.md` — artifact format, both snippets, toolkit API reference.

---

## 13. Open questions / fast-follows

- **Per-knob rename/hide** in the publish UI (v1 auto-exposes all uniform knobs).
- **Self-hosted scene file** for image-heavy scenes (v2).
- **Pointer/mouse node + `u_mouse`** across both backends (v2).
- **Shared/offscreen GPU context** for many-embed pages (v2).
- **Identifier minification** pass for further payload shrink (later hook).
