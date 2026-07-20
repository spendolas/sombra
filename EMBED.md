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

There is **one** embed snippet. It auto-mounts *and* is controllable — you don't
choose between "simple" and "developer" up front. An `iframe` fallback exists for
strict-CSP / paste-and-forget cases.

### Embed (auto-mount, controllable)

Lazy-loads the player once (cached across embeds and across sites), then
auto-mounts every `[data-sombra-scene]` element. The `id` makes it addressable.

```html
<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");i.src="https://spendolas.github.io/sombra/embed/sombra-player.0.1.0.umd.js";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>
<div id="sombra-shader" data-sombra-scene="<BASE64URL_ARTIFACT>" style="width:100%;aspect-ratio:16/9"></div>
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

`Sombra.mount(el, { scene, onLoad })` is still available for hosts that prefer to
mount explicitly rather than via the `data-` attribute.

### iframe (isolated fallback)

Maximum isolation, zero host JS — but **heaviest at runtime** (it ships the graph
and recompiles in-frame) and exposes **no knob API**. Use only for strict-CSP
hosts or true paste-and-forget. Renders the viewer via the compact `#g=` hash.

```html
<iframe src="https://spendolas.github.io/sombra/viewer.html#g=<HASH>" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>
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
else its type label ("Noise"), disambiguated with " 2"/" 3". The Embed modal's
Developer tab groups the knob table under these node names.

```ts

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
  get(idOrEl: string | HTMLElement): SceneHandle | undefined  // handle of an auto-mounted embed
  version: string       // EMBED_VERSION, e.g. "0.1.0"
}
```

Any successful mount (auto or explicit) registers its handle, so `Sombra.get(el)`
returns it and a **`sombra:load`** `CustomEvent` (`event.detail.handle`) fires on
the element. That's what makes the single auto-mount embed controllable without a
separate `mount()` call.

### `MountOptions`

| Field       | Type                                    | Default | Meaning |
|-------------|-----------------------------------------|---------|---------|
| `scene`     | `string`                                | —       | base64url artifact (required) |
| `variables` | `Record<string, number \| number[]>`    | —       | initial knob overrides, keyed by knob `key` |
| `autoplay`  | `boolean`                               | `true`  | start the animation loop when visible |
| `fallback`  | `boolean`                               | `true`  | on error, show the bouncing “SOMBRA” placeholder in the container |
| `debug`     | `boolean`                               | `false` | overlay the error message on the fallback |
| `onLoad`    | `(h: SceneHandle) => void`              | —       | called once the scene is mounted and rendering |
| `onError`   | `(e: Error) => void`                    | —       | called on decode/renderer‑init failure |

`mount()` always resolves — it never rejects. On decode or renderer‑init failure
it logs `[Sombra] …`, calls `onError`, shows the DVD-style fallback (unless
`fallback: false`), and returns a no‑op handle whose `destroy()` removes the
fallback (every other method
is a safe stub), so host code can call the handle unconditionally. It also
returns the no‑op handle when there is no DOM (`window === undefined`) or no
element, making SSR safe.

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
the key's suffix, not the raw internal id. The Embed modal's Developer tab prints
the node id + a copy button + a ready `set(id, param, value)` line per node.

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
