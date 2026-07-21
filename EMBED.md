# Embedding Sombra shaders

Publish a finished shader from the Sombra editor and drop it onto any third‑party
website with a copy‑paste snippet. A standalone **player** bundle (renderer +
decoder + performance harness — **no React, no xyflow, no compiler, no nodes**)
decodes the shader and drives the render loop. A small JS API (`Sombra.mount`)
exposes every knob to the host page so the surrounding site can drive the shader.

- **Two file types (distinct extensions):**
  - **`.sombra`** — the **editor graph** (`{ sombra, nodes, edges }` JSON). What
    the editor saves/opens; editable. Handled by `src/utils/sombra-file.ts`.
  - **`.ombra`** — the **compiled shader** (this doc's artifact: deflated binary
    `SceneArtifact`, no graph). What the player renders; not editable. A `.ombra`
    is the *compiled output* of a `.sombra` and can't be turned back into one.
- **Editor entry point:** the `</>` (code) button in the graph toolbar opens the
  Embed modal. It compiles the current graph and offers a **Download .ombra**
  file plus copy-paste snippets (hosted, inline, iframe).
- **Two scene transports:**
  - **Hosted file (primary):** download a `.ombra` file (deflated binary — *no*
    base64, ~25% smaller than inline), host it anywhere, and reference it with
    `data-sombra-src="<url>"`. The player `fetch`es and inflates it.
  - **Inline:** the whole artifact base64url-encoded into `data-sombra-scene` —
    self-contained, no hosting, but a large attribute. Good for small scenes.
- **Player bundle:** `dist/embed/sombra-player.<version>.umd.js`, served from the
  CDN at `https://spendolas.github.io/sombra/embed/`.
- **Scope (v1):** *frozen* scenes — the compiled shader plus a manifest of knobs
  (unwired `updateMode:'uniform'` params) the host can set at runtime. The graph
  itself is not shipped; the artifact carries only compiled output. The artifact
  reserves `kind: 'frozen'` with a door open for a future `kind: 'live'`.

---

## 1. Quick start

Every embed variant auto-mounts *and* is controllable — you don't choose between
"simple" and "developer" up front. Pick a **transport**: a hosted `.ombra` file
(primary), the inline artifact, or the isolated `iframe` fallback.

### Hosted file (primary) — `data-sombra-src`

Download the `.ombra` file from the Embed modal, host it anywhere, and reference
its URL. The player lazy-loads once (cached across embeds and sites), then fetches
+ inflates the file and mounts it. Tiny snippet regardless of scene size.

```html
<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");i.src="https://spendolas.github.io/sombra/embed/sombra-player.0.1.0.umd.js";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>
<div id="sombra-shader" data-sombra-src="https://your-host.example/scene.ombra" style="width:100%;height:100%"></div>
```

> **CORS:** if the file is served from a different origin than the page, its host
> must send `Access-Control-Allow-Origin` (most static hosts can). Same-origin
> needs no config. On a 404 / CORS block / malformed file the player fires a
> `sombra:error` event and shows the fallback instead of crashing.

### Inline (self-contained) — `data-sombra-scene`

The whole artifact base64url'd into the attribute — no file to host, but a large
string. Best for small scenes / paste-and-forget.

```html
<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");i.src="https://spendolas.github.io/sombra/embed/sombra-player.0.1.0.umd.js";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>
<div id="sombra-shader" data-sombra-scene="<BASE64URL_ARTIFACT>" style="width:100%;height:100%"></div>
```

### Control it (optional — same embed, no second mount)

Grab the handle when the scene goes live via the `sombra:load` event, or later
via `Sombra.get(idOrElement)`. This is the "developer mode" — it's just the embed
above plus a handle.

```html
<script>
  document.getElementById('sombra-shader').addEventListener('sombra:load', function (e) {
    var shader = e.detail.handle;              // or: Sombra.get('sombra-shader')
    shader.set('noise-scale', 3);              // flat key
    var noise = shader.nodes().find(function (n) { return n.type === 'noise'; });
    shader.set(noise.id, 'seed', 12);          // stable, node-directed
    shader.get(noise.id, 'scale');             // read current live value
  });
</script>
```

`Sombra.mount(el, { scene, onLoad })` or `Sombra.mount(el, { src, onLoad })` is
still available for hosts that prefer to mount explicitly rather than via the
`data-` attribute.

### iframe (isolated fallback)

Maximum isolation, zero host JS — but **heaviest at runtime** (it ships the graph
and recompiles in-frame) and exposes **no knob API**. Use only for strict-CSP
hosts or true paste-and-forget. Renders the viewer via the compact `#g=` hash.

```html
<iframe src="https://spendolas.github.io/sombra/viewer.html#g=<HASH>" style="width:100%;height:100%;border:0" allowfullscreen></iframe>
```

### Playing well with the host page

The player is a self-contained UMD bundle: its dependencies (e.g. `pako`) are
scoped inside it and are **not** written to the host's globals, so a host that
already uses `pako` is unaffected (verified by the Embed Tester's conflict mode).
The only global it defines is `window.Sombra`, and loading the bundle twice is a
no-op (the loader guards on `Sombra.init`, and auto-init is idempotent). It ships
no stylesheet — only inline styles on its own canvas/fallback — so it can't
restyle the host. On a heavy host (many live WebGL contexts) the embed still
mounts and its offscreen instances pause via IntersectionObserver.

The iframe path ships the *graph* (decoded and recompiled in‑iframe), not the
frozen artifact, so it is heavier at runtime but needs no player bundle and is
fully sandboxed.

---

## 2. The Scene Artifact

The artifact is produced by `src/embed/publish.ts` `publishScene(nodes, edges)`
and consumed by `src/embed/player.ts` `mount()`. It ships in one of two transports
— inline in the attribute, or as a hosted file — that differ only in the final
encoding step (base64 vs raw binary); the artifact itself is identical.

### Pipeline

```
graph (nodes+edges)
  → compileGraph / compileGraphIR        (RenderPlan, GLSL + WGSL passes)
  → stripPlan(plan)                      (drop vertex shaders)
  → SceneArtifact { plan, manifest, images, meta }
  → JSON.stringify → pako.deflate → ┬─ base64url   (encodeArtifact  → inline string)
                                    └─ raw bytes    (encodeArtifactBytes → .ombra file)
```

On the player side the reverse runs — `decodeArtifact` (base64) or
`decodeArtifactBytes` (fetched `ArrayBuffer`) → `reconstructPlan` — then
`createShaderRenderer(canvas).updateRenderPlan(plan)`.

`publishScene` returns both forms: `sceneB64` (inline) and `sceneBytes`
(`Uint8Array`, the `.ombra` file), plus `sizeBytes`/`fileBytes` for each.

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
  key: string                    // node-scoped, deduped: "noise-scale", "noise-2-scale"
  uniform: string                // wire name: "u_<nodeId>_<param>"
  nodeId: string                 // stable node id — pass to set(nodeId, param, value)
  node: string                   // owning node's display name: "Noise", "Noise 2"
  nodeType: string               // machine node type: "noise" — filter with nodes()
  param: string                  // friendly param slug: "scale" (matches the key suffix)
  label: string                  // the param's own label: "Scale"
  type: 'float' | 'vec2' | 'vec3' | 'color'
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  min?: number; max?: number; step?: number
  default: number | number[]
}
// variables() returns Knob = KnobDescriptor & { value }; nodes() returns
// NodeInfo = { id, name, type, params: Knob[] }.
```

Keys are **node-scoped** — `<node>-<param>` (e.g. `noise-scale`, `noise-2-scale`,
`warp-offset-x`) — so a knob is traceable to the effect it drives even when many
nodes expose same-named params. The node name is the node's custom label if set,
else its type label ("Noise"), disambiguated with " 2"/" 3". The host discovers
these at runtime via `shader.nodes()` / `shader.variables()`.

```ts

interface ImageAsset {
  sampler: string                // "u_<sanitizedNodeId>_image"
  dataUrl: string                // base64 data URL
}
```

**Reachable-only baking.** `collectImages` bakes an image node's data URL only if
the node is reachable from the Fragment Output (same topo-sorted set the shader
and manifest use). A dead-ended / disconnected image node contributes **zero**
bytes — no orphan blob the shader never samples. Shader source and the knob
manifest are already reachable-only for the same reason.

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

All four codec functions share one core (`JSON.stringify` → `pako.deflate`), and
differ only in whether the deflated bytes are base64-wrapped:

- **`encodeArtifactBytes(a)` / `decodeArtifactBytes(bytes)`** — deflated JSON as raw
  `Uint8Array`. This is the hosted `.ombra` file: the player fetches it as an
  `ArrayBuffer` and inflates. No base64, so it's **~25% smaller** than the inline
  string, and self-compressed (small on any static host, no gzip/brotli needed).
- **`encodeArtifact(a)` / `decodeArtifact(s)`** — the same bytes wrapped in
  base64url (`+/=` → `-_`, padding stripped) for a `data-` attribute. Base64
  encoding is chunked (`0x8000` bytes) to avoid `String.fromCharCode(...)`
  `RangeError` on large buffers.

The codec is lossless (verified by round-trip), and `Map`s in the plan (the WGSL
`uniformLayout.offsets`) are preserved via a tagged replacer/reviver — plain
`JSON.stringify` would serialize them to `{}` and break WebGPU uniform uploads.

> **Not minified before deflate.** Stripping shader-source comments/whitespace was
> built, GPU-verified safe, then **measured and rejected**: it shrinks raw text
> ~6% but the artifact is deflated, and removing that highly-repetitive text
> *reduces* the redundancy deflate exploits, making the final `.ombra` **~10%
> larger**. Deflate already handles whitespace; don't re-add a minify step here.

---

## 3. The player API (`window.Sombra`)

The UMD bundle assigns a global `Sombra` and auto‑inits on load:

```ts
window.Sombra = {
  mount(el: HTMLElement, opts: MountOptions): Promise<SceneHandle>
  init(): void          // scan + mount all [data-sombra-scene|src|id]
  get(idOrEl: string | HTMLElement): SceneHandle | undefined  // handle of an auto-mounted embed
  configure(opts: { resolve?: (ref: string) => string }): void  // scene-ref resolver seam
  version: string       // EMBED_VERSION, e.g. "0.1.0"
}
```

Any successful mount (auto or explicit) registers its handle, so `Sombra.get(el)`
returns it and a **`sombra:load`** `CustomEvent` (`event.detail.handle`) fires on
the element. That's what makes the single auto-mount embed controllable without a
separate `mount()` call. A failed mount fires **`sombra:error`**
(`event.detail.error`) on the element instead.

**Resolver seam (`configure`).** A `src`/`id` container references its scene by a
string ref, which the player runs through `resolve(ref)` before fetching. The
default resolver is identity (the ref is already a URL). This is the forward-compat
hook for a future short-code / CDN service: point ids at a service with one call
and no page changes —

```js
Sombra.configure({ resolve: id => `https://cdn.example/scenes/${id}.ombra` });
// then: <div data-sombra-id="momsflowers" ...>
```

### `MountOptions`

| Field       | Type                                    | Default | Meaning |
|-------------|-----------------------------------------|---------|---------|
| `scene`     | `string`                                | —       | inline base64url artifact — one of `scene`/`src` required |
| `src`       | `string`                                | —       | scene ref (hosted `.ombra` URL, or an id run through the resolver), fetched as binary |
| `variables` | `Record<string, number \| number[]>`    | —       | initial knob overrides, keyed by knob `key` |
| `autoplay`  | `boolean`                               | `true`  | start the animation loop when visible |
| `fallback`  | `boolean`                               | `true`  | on error, show the bouncing “SOMBRA” placeholder in the container |
| `debug`     | `boolean`                               | `false` | overlay the error message on the fallback |
| `onLoad`    | `(h: SceneHandle) => void`              | —       | called once the scene is mounted and rendering |
| `onError`   | `(e: Error) => void`                    | —       | called on decode/renderer‑init failure |

`mount()` always resolves — it never rejects. On any failure — a `src` fetch error
(404 / network / CORS), decode, or renderer‑init — it logs `[Sombra] …`, calls
`onError`, dispatches `sombra:error` on the element, shows the DVD-style fallback
(unless `fallback: false`), and returns a no‑op handle whose `destroy()` removes
the fallback (every other method is a safe stub), so host code can call the handle
unconditionally. It also returns the no‑op handle when there is no DOM
(`window === undefined`) or no element, making SSR safe.

### `SceneHandle`

| Method                       | Behavior |
|------------------------------|----------|
| `set(key, value)`            | Override a knob by its flat `key` (e.g. `'noise-scale'`). Unknown keys log a warning listing valid keys. A 3‑component value on a `vec4` (color) knob is padded to alpha `1`. |
| `set(nodeId, param, value)`  | Override a knob by **stable node id** + friendly param (e.g. `set('noise-1784…','scale',3)`). Same target as the flat form; the stable, unambiguous way to address one node among several of the same type. |
| `get(key)` / `get(nodeId, param)` | The knob's **current live value** (default, or whatever was last `set`), or `undefined`. |
| `variables()`                | `Knob[]` — the full flat list, each with its current `value`. Enumerate knobs, ranges, defaults, and node identity. |
| `nodes()`                    | `NodeInfo[]` — knobs **grouped by owning node** (`{ id, name, type, params }`). The deliberate way to discover and target nodes: `nodes().filter(n => n.type==='noise').forEach(n => set(n.id,'seed',0))`. |
| `play()`                     | Mark autoplay wanted and resume the loop (only animates if the shader is time‑live). |
| `pause()`                    | Mark autoplay unwanted and stop the loop. |
| `resize()`                   | Request one frame (the harness also auto‑resizes via `ResizeObserver`). |
| `destroy()`                  | Stop the harness + loop, dispose the renderer, remove the canvas. |
| `on(event, cb)`              | Subscribe to `'load'`, `'error'`, or `'contextlost'`. |

**Addressing knobs.** Every knob has both a flat `key` (`<node>-<param>`, e.g.
`noise-2-scale`) and a `(nodeId, param)` pair. The flat key is terse for one‑offs;
the `(nodeId, param)` form is **stable across re‑publish and graph edits** (the
node id never shifts) and unambiguous when several nodes share a type — prefer it
for anything you commit to code. `param` is the friendly slug (`scale`), matching
the key's suffix, not the raw internal id. Enumerate them from the live handle:
`shader.nodes()` gives `{ id, name, type, params }` per node, ready for
`set(id, param, value)`.

Value conventions: `float` → `number`; `vec2`/`vec3` → `number[]`; `color` →
`[r, g, b]` in 0..1 (alpha auto‑padded). Ranges come from each knob's
`min`/`max`/`step`.

---

## 4. `data-sombra-*` attributes

`init()` (and the auto‑init on load) scans for `[data-sombra-scene]`,
`[data-sombra-src]`, and `[data-sombra-id]` and mounts each element. It is
**idempotent** — a mounted element is marked (`data-sombra-mounted`) and skipped
on re‑scan, so calling `Sombra.init()` again after inserting new DOM is safe and
never double‑mounts.

A container declares its scene with **one** of these, checked in order
(`scene` → `src` → `id`):

| Attribute              | Values          | Meaning |
|------------------------|-----------------|---------|
| `data-sombra-scene`    | base64url       | inline artifact — self-contained, no fetch |
| `data-sombra-src`      | URL             | hosted `.ombra` file, fetched as binary (cross-origin ⇒ needs `Access-Control-Allow-Origin`) |
| `data-sombra-id`       | string          | ref resolved to a URL by `Sombra.configure({ resolve })`, then fetched |
| `data-sombra-autoplay` | `"true"`/`"false"` | default `true`; `"false"` mounts paused |
| `data-sombra-debug`    | `"true"`        | write init errors into the element |

**Sizing.** The generated snippet defaults the container to `width:100%;height:100%`,
so the embed fills whatever space the host gives it (the canvas fills the container
at `width/height:100%` and re-renders on resize via `ResizeObserver`). Because
`height:100%` resolves against the parent, **the host must give the wrapping element
a height** — e.g. drop it in a sized/flex/grid container, or set an explicit height
(`height:400px`, `height:100vh`) or `aspect-ratio` on the container. In a plain
auto-height flow the box would collapse to 0 and show nothing.

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
compiled shader plus a manifest of unwired `uniform`‑mode params, shippable inline
or as a hosted `.ombra` file. The Embed modal shows a file‑size badge and warns
when baked images make the artifact large.

**Doors left open:**
- `SceneArtifact.kind` reserves `'frozen'` today with `'live'` planned — a future
  artifact could ship the graph and recompile on the host for live editing.
- The `configure({ resolve })` seam + `data-sombra-id` are the hook for a future
  **short-code / CDN service**: it only needs to map an id → a `.ombra` URL, with
  zero changes to already-embedded pages.

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
