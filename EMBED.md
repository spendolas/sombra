# Embedding Sombra shaders

Publish a finished shader from the Sombra editor and drop it onto any third‑party
website with a copy‑paste snippet. A standalone **player** bundle (renderer +
decoder + performance harness — **no React, no xyflow, no compiler, no nodes**)
decodes the shader and drives the render loop. A small JS API (`Sombra.mount`)
exposes every knob to the host page so the surrounding site can drive the shader.

- **Editor entry point:** the `</>` (code) button in the graph toolbar opens the
  Embed modal, which compiles the current graph and hands you three snippets.
- **Player bundle:** `dist/embed/sombra-player.<version>.umd.js`, served from the
  CDN at `https://spendolas.github.io/sombra/embed/`.
- **Scope (v1):** *frozen* scenes — the compiled shader plus a manifest of knobs
  (unwired `updateMode:'uniform'` params) the host can set at runtime. The graph
  itself is not shipped; the artifact carries only compiled output. The artifact
  reserves `kind: 'frozen'` with a door open for a future `kind: 'live'`.

---

## 1. Quick start

### Copy‑paste (auto‑mount)

The simplest snippet. It lazy‑loads the player (once, even across multiple
embeds), then auto‑mounts every `[data-sombra-scene]` element on the page.

```html
<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");i.src="https://spendolas.github.io/sombra/embed/sombra-player.0.1.0.umd.js";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>
<div data-sombra-scene="<BASE64URL_ARTIFACT>" style="width:100%;aspect-ratio:16/9"></div>
```

### Developer (programmatic mount + knobs)

Use this when the host page needs a handle to drive the shader. `mount()` is
async; use `onLoad` to get the ready `SceneHandle` (same pattern as Rive/Spline).

```html
<script src="https://spendolas.github.io/sombra/embed/sombra-player.0.1.0.umd.js"></script>
<div id="my-shader" style="width:100%;aspect-ratio:16/9"></div>
<script>
  Sombra.mount(document.getElementById('my-shader'), {
    scene: "<BASE64URL_ARTIFACT>",
    onLoad: function (shader) {
      // shader.set('intensity', 0.65);
    }
  });
</script>
```

### Advanced (iframe fallback)

Zero JS, maximum isolation. Renders the full viewer inside an iframe using the
compact share hash (the same `#g=` hash used by the "Copy shareable viewer URL"
button). Available only when the modal has a viewer hash to embed.

```html
<iframe src="https://spendolas.github.io/sombra/viewer.html#g=<HASH>" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>
```

The iframe path ships the *graph* (decoded and recompiled in‑iframe), not the
frozen artifact, so it is heavier at runtime but needs no player bundle and is
fully sandboxed.

---

## 2. The Scene Artifact

The snippet carries the whole scene inline as a base64url string. It is produced
by `src/embed/publish.ts` `publishScene(nodes, edges)` and consumed by
`src/embed/player.ts` `mount()`.

### Pipeline

```
graph (nodes+edges)
  → compileGraph / compileGraphIR        (RenderPlan, GLSL + WGSL passes)
  → stripPlan(plan)                      (drop vertex shaders)
  → SceneArtifact { plan, manifest, images, meta }
  → JSON.stringify → pako.deflate → base64url        (encodeArtifact)
```

On the player side the reverse runs (`decodeArtifact` → `reconstructPlan`), then
`createShaderRenderer(canvas).updateRenderPlan(plan)`.

### Shape (`src/embed/artifact.ts`)

```ts
interface SceneArtifact {
  v: 1
  kind: 'frozen'                 // reserved: future 'live'
  plan: SerializedPlan           // RenderPlan minus every vertex shader
  manifest: KnobDescriptor[]     // one per host-settable knob
  images: ImageAsset[]           // baked image textures (data URLs)
  meta: { anchor: [number, number]; timeSpeed: number }
}

interface KnobDescriptor {
  key: string                    // friendly, deduped slug: "scale", "scale-2"
  uniform: string                // wire name: "u_<nodeId>_<param>"
  label: string
  type: 'float' | 'vec2' | 'vec3' | 'color'
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  min?: number; max?: number; step?: number
  default: number | number[]
}

interface ImageAsset {
  sampler: string                // "u_<sanitizedNodeId>_image"
  dataUrl: string                // base64 data URL
}
```

### Vertex‑omission invariant

Every Sombra shader uses the *same* fullscreen‑quad vertex stage, so shipping it
per‑pass is pure waste **and** would force the player to import the compiler.
Instead:

- `stripPlan(plan)` removes `vertexShader` from the top‑level plan **and** from
  every pass.
- The player owns a byte‑identical copy of that vertex shader in
  `src/embed/vertex.ts` (`GLSL_VERTEX_SHADER`) and `reconstructPlan(sp)`
  re‑attaches it to the plan and every pass before handing it to the renderer.
- **Invariant:** `GLSL_VERTEX_SHADER` MUST stay byte‑identical to
  `VERTEX_SHADER` in `src/compiler/glsl-generator.ts`. This is asserted by
  `scripts/verify-artifact-roundtrip.ts`. If you change the compiler's vertex
  shader, update the player copy or the round‑trip check fails.

### Codec

`encodeArtifact` / `decodeArtifact` use `pako` deflate + base64url
(`+/=` → `-_`, padding stripped). Base64 encoding is chunked (`0x8000` bytes) to
avoid `String.fromCharCode(...)` `RangeError` on large buffers. The codec is
lossless (verified by round‑trip).

---

## 3. The player API (`window.Sombra`)

The UMD bundle assigns a global `Sombra` and auto‑inits on load:

```ts
window.Sombra = {
  mount(el: HTMLElement, opts: MountOptions): Promise<SceneHandle>
  init(): void          // scan + mount all [data-sombra-scene]
  version: string       // EMBED_VERSION, e.g. "0.1.0"
}
```

### `MountOptions`

| Field       | Type                                    | Default | Meaning |
|-------------|-----------------------------------------|---------|---------|
| `scene`     | `string`                                | —       | base64url artifact (required) |
| `variables` | `Record<string, number \| number[]>`    | —       | initial knob overrides, keyed by knob `key` |
| `autoplay`  | `boolean`                               | `true`  | start the animation loop when visible |
| `debug`     | `boolean`                               | `false` | write init errors into the container's text |
| `onLoad`    | `(h: SceneHandle) => void`              | —       | called once the scene is mounted and rendering |
| `onError`   | `(e: Error) => void`                    | —       | called on decode/renderer‑init failure |

`mount()` always resolves — it never rejects. On decode or renderer‑init failure
it logs `[Sombra] …`, calls `onError`, and returns a no‑op handle (every method
is a safe stub), so host code can call the handle unconditionally. It also
returns the no‑op handle when there is no DOM (`window === undefined`) or no
element, making SSR safe.

### `SceneHandle`

| Method                       | Behavior |
|------------------------------|----------|
| `set(key, value)`            | Override a knob by its `key`. Unknown keys log a warning listing valid keys. A 3‑component value on a `vec4` (color) knob is padded to alpha `1`. |
| `get(key)`                   | The knob's **default** value (not the live override), or `undefined`. |
| `variables()`                | A copy of the full `KnobDescriptor[]` — enumerate knobs, ranges, and defaults. |
| `play()`                     | Mark autoplay wanted and resume the loop (only animates if the shader is time‑live). |
| `pause()`                    | Mark autoplay unwanted and stop the loop. |
| `resize()`                   | Request one frame (the harness also auto‑resizes via `ResizeObserver`). |
| `destroy()`                  | Stop the harness + loop, dispose the renderer, remove the canvas. |
| `on(event, cb)`              | Subscribe to `'load'`, `'error'`, or `'contextlost'`. |

Value conventions: `float` → `number`; `vec2`/`vec3` → `number[]`; `color` →
`[r, g, b]` in 0..1 (alpha auto‑padded). Ranges come from each knob's
`min`/`max`/`step`.

---

## 4. `data-sombra-*` attributes

`init()` (and the auto‑init on load) scans for `[data-sombra-scene]` and mounts
each element. It is **idempotent** — a mounted element is marked
(`data-sombra-mounted`) and skipped on re‑scan, so calling `Sombra.init()` again
after inserting new DOM is safe and never double‑mounts.

| Attribute              | Values          | Meaning |
|------------------------|-----------------|---------|
| `data-sombra-scene`    | base64url       | the artifact to mount (required) |
| `data-sombra-autoplay` | `"true"`/`"false"` | default `true`; `"false"` mounts paused |
| `data-sombra-debug`    | `"true"`        | write init errors into the element |

Give the container an explicit size (e.g. `width:100%;aspect-ratio:16/9`); the
canvas fills it at `width/height:100%`.

---

## 5. Performance harness

Every mounted embed is gated by `src/embed/perf-harness.ts` `PerfHarness` so an
off‑screen or backgrounded shader burns no GPU:

- **IntersectionObserver** (`rootMargin: '50px'`, `threshold: 0.01`) — pauses the
  loop when the element scrolls out of view, resumes when it returns.
- **`visibilitychange`** — pauses when the browser tab is hidden.
- **`prefers-reduced-motion: reduce`** — renders exactly one static frame and
  never starts a loop. `reducedMotion` is exposed read‑only on the harness.
- **ResizeObserver** — requests a frame when the container resizes.

Manual `play()`/`pause()` set an `autoplayWanted` flag that the visibility gate
respects: the loop only runs when the shader is time‑live, autoplay is wanted,
the element is in view, and the tab is visible. Static (non‑time‑live) shaders
render on demand and never spin a loop. `destroy()` disconnects all observers.

---

## 6. Backends & resilience

- **WebGPU‑first, WebGL2 fallback.** The player reuses the app's
  `createShaderRenderer` factory (`src/renderer/create-renderer.ts`): it tries
  WebGPU and falls back to WebGL2. The artifact carries **both** the GLSL passes
  and (when the publishing browser had WebGPU) the WGSL passes, so either backend
  can drive the same scene on the viewer's machine.
- **Context loss.** On device/context loss the player re‑applies the full render
  plan, re‑bakes uniforms, re‑uploads image textures, and emits `contextlost`.
- **Async image textures.** Baked images decode asynchronously; each re‑renders
  (static) or is picked up by the running loop (animated) as it lands.

---

## 7. Versioning & CDN

`src/embed/version.ts` is the single source of truth:

```ts
export const EMBED_VERSION = '0.1.0'
export const CDN_BASE      = 'https://spendolas.github.io/sombra/embed'
export const PLAYER_UMD_URL = `${CDN_BASE}/sombra-player.${EMBED_VERSION}.umd.js`
```

- The player filename is **version‑pinned** (`sombra-player.0.1.0.umd.js`) so a
  published snippet keeps rendering against the exact player it was built for;
  new player versions ship under new filenames and never break old embeds.
- `EMBED_VERSION` drives the build output name (`vite.embed.config.ts`), the
  snippet URLs (`buildSnippets`), and the bundle‑gate path
  (`scripts/verify-embed-bundle.ts`). Bump it in one place.
- The player ships to Pages via `npm run build` (which chains
  `npm run build:embed`) into `dist/embed/`.

---

## 8. Building & verifying

```bash
npm run build:embed              # build dist/embed/sombra-player.<version>.umd.js
npm run verify:embed             # pure offline checks (artifact + manifest + snippets)
npm run verify:embed:bundle      # after build:embed — no forbidden deps, under size budget
npm run verify:embed:smoke       # end-to-end browser smoke (needs dev server + playwright)
```

Individual checks: `verify:embed:artifact` (lossless codec + vertex invariant),
`verify:embed:manifest` (uniform↔metadata join + dedup), `verify:embed:snippets`
(version‑pinned, artifact‑carrying snippets), `verify:embed:bundle` (the player
imports **no** React/xyflow/compiler/nodes and stays under the gzip budget).

The smoke script (`scripts/verify-embed-smoke.ts`) drives `embed-dev.html` with
`playwright-core`: it waits for mount, samples canvas pixels for non‑black output,
and calls `handle.set()` on the first knob. Run the dev server first:

```bash
npm run dev                                   # terminal 1
npx tsx scripts/verify-embed-smoke.ts         # terminal 2 (needs a Chromium binary)
```

If no Chromium binary is available, run the smoke manually: open
`http://localhost:5173/sombra/embed-dev.html` and execute the two `page.evaluate`
bodies in the console.

**Bundle rule (enforced):** the player import graph
(`src/embed/index.ts` + its imports) may import only `src/renderer/*`,
`src/embed/*`, and `pako`. It must **not** import React, `@xyflow/react`,
`src/compiler/*`, `src/nodes/*`, or `src/utils/sombra-file.ts`. Editor‑side
modules (`manifest.ts`, `publish.ts`, `EmbedModal.tsx`) may import compiler/nodes
because they run in the editor, never in the shipped player. `import type` is
erased at build, so type‑only imports of compiler types are fine everywhere.

---

## 9. Scope & fast‑follows

**v1 (this release):** frozen scenes, knobs‑only. The published artifact is the
compiled shader plus a manifest of unwired `uniform`‑mode params. The Embed modal
shows a payload‑size badge and warns when baked images make the artifact large.

**Door left open:** `SceneArtifact.kind` reserves `'frozen'` today with `'live'`
planned — a future artifact could ship the graph and recompile on the host for
live editing.

**Fast‑follows (not in v1):**

- **Pointer / `u_mouse`** — forward host pointer events into the shader's mouse
  uniform so embeds react to cursor position.
- **Self‑hosted player file** — let the host serve the UMD bundle from its own
  origin instead of the Sombra CDN (offline/CSP‑restricted sites).
- **Per‑knob rename** — let the publisher choose friendly knob keys/labels at
  publish time rather than auto‑slugging param labels.
- **Shared rendering context** — one GPU device/context shared across multiple
  embeds on a page (today each embed creates its own renderer).
- **Minification** — minify the player bundle (currently unminified) to shrink
  the gzip payload.
- **Image WebP downscale** — at publish, re‑encode baked images to WebP with a
  max‑dimension cap (`reencodeImages(images, maxDim)` via an offscreen canvas
  `toDataURL('image/webp')`), wired to a toggle that re‑runs `publishScene`.
  v1 ships only the size badge + warning; this is the actual re‑encode.
