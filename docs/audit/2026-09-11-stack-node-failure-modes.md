# Stack node — failure-mode audit

**Date:** 2026-09-11 · **Scope:** what breaks when users drive a Stack compositing node
however the design lets them. Three parallel audits against the current `main`: resource
ceilings, state lifecycle, graph topology.

Severity is "what the user sees", not "how deep the bug is". **Silent wrong output outranks
a crash** — a crash tells you something is wrong.

---

## P0 — blocks the node entirely

### 1. `dynamicInputs` is invisible to texture-boundary detection

`partitionPasses`' quick-check (`glsl-generator.ts:156`) and `findTextureBoundaries`
(`:255`) both iterate `def.inputs`. Only the depth loop between them resolves
`dynamicInputs` (`:180-182`). Every other consumer in the app is dynamic-aware —
`FlowCanvas.tsx:270`, `ShaderNode.tsx:284`, `sombra-file.ts:382`, `graphStore.ts:469`,
`generateNodeGlsl` (`:440`), `generateNodeIR` (`ir-compiler.ts:151`).

Dynamically-declared layer ports therefore raise pass depth but never produce a
`TextureBoundaryEdge` or a sampler. Two silent outcomes: `hasTextureBoundary` stays false →
`partitionPasses` returns null → the whole graph collapses to the single-pass path and
every layer emits its unwired fallback; or a boundary exists elsewhere and wired layers
resolve through `resolveInputDefault`, rendering as their port default.

Both helpers are shared by all four compilers (`glsl-generator.ts:665,749`,
`ir-compiler.ts:513,587`, `subgraph-compiler.ts:92,178`, `ir-subgraph-compiler.ts`), so one
fix covers main and preview on both backends.

### 2. A wired-but-unread layer port kills WebGPU only

`findTextureBoundaries` creates a boundary for any wired `textureInput` whether or not the
node's codegen reads it. The WGSL assembler emits the binding unconditionally
(`wgsl-assembler.ts:286-300`), but the pipeline's `layout:'auto'` omits unused bindings, so
`createBindGroup` throws, `buildPassTextureBindGroup` swallows it and returns null
(`webgpu/renderer.ts:800-809`), `setBindGroup(1, …)` is skipped (`:1233`), and the GPU
validation error invalidates the entire encoder. WebGL2 just skips the missing uniform
location (`webgl/renderer.ts:948`) and renders correctly.

**Reachable by an ordinary action:** reduce the layer count from 5 to 3 with wires still on
layers 4-5. Those edges are stripped only on localStorage `migrate` (`graphStore.ts:462-472`)
and file load (`sombra-file.ts:374-387`) — **never on a param change**.

**Fix:** Stack's `glsl()`/`ir()` must emit a sample for *every* sampler present in
`ctx.textureSamplers`, including layers its loop ignores; and layer removal must strip the
edges immediately (P1.1).

> **Confirmed on hardware (Phase A execution, 2026-09-12)** with a synthetic node declaring
> texture ports it never reads. `updateRenderPlan` returns **success**, nothing throws, and
> the draw raises an uncaptured validation error: `"No bind group set at group index 1."` —
> the whole command encoder is invalidated. Pinned as a tripwire by gate 8 of
> `verify-renderer-caps-gpu`, which asserts the *broken* signature and goes red when P0.2 is
> fixed; whoever fixes it flips the assertion to `uncaptured.length === 0`.
>
> The same unread-port condition was a silent texture-unit overflow on WebGL2 — fixed in
> Phase A (`f9d8c72`). On WebGPU it remains open and is Phase B framework work on the WGSL
> assembler.

---

## P1 — silent wrong output

### 1. Index-keyed ports silently mis-assign images

Nothing in the codebase rewrites `edge.targetHandle` — not the store, not persist, not the
`.sombra` importer. Port resolution is a plain string match (`ir-compiler.ts:169`,
`glsl-generator.ts:444`).

Delete layer 1 of 4 and the wire on `layer_2` resolves against the *new* `layer_2`, i.e.
the old layer 3: **wrong image on wrong layer, no error**. Simultaneously the edge on the
vanished `layer_3` is never pruned at runtime, survives reloads, and re-attaches when a
layer is added back. Reorder has the same shape — wires stay bolted to slot numbers while
content moves out from under them, and since visual order follows the array, the mismatch
reads as a rendering bug.

`arithmetic` never hit this: it appends and removes from the **tail** only
(`ShaderNode.tsx:122-144`).

**Fix:** stable per-layer ids (`layer_<uuid>`), generated on layer creation and never
reused. Not a preference — a requirement. Note edge ids are minted as
`${source}-${sh}-${target}-${th}` (`App.tsx:212`, `FlowCanvas.tsx:205`), so any
index-rewriting scheme would have to rewrite edge ids too.

### 2. WebGL2 over-cap renders the wrong texture, reports success

Desktop cap is **8** intermediates, mobile **4** (`webgl/renderer.ts:129-131`, `191-207`).
Over it: `console.warn("…Some passes may not render.")` at `:363-366`, then
`updateRenderPlan` still returns `success:true` (`:557`). At draw time passes past the cap
are skipped (`:922-923`) and their consumer's sampler uniform is **never set**, so it
defaults to unit 0 — **the pass samples whatever happens to be bound there.**

Observable: a 9-layer Stack on WebGL2 shows layers 9+ as duplicates of layer 1. Nothing
reaches the UI. This is the single worst failure mode found.

Also reachable without many layers: Pyramid Blur at N=3 already uses 7 passes, so a
**3-layer** Stack over a pyramid blur blows the cap.

**Fix:** return `{success:false}` instead of warning; the error path to the UI already
exists (`App.tsx:75-86`).

### 3. `maxTextureImageUnits` — mechanism corrected; the real bug is a phantom unit counter

Read once (`webgl/renderer.ts:193`) and used solely to compute `maxIntermediateTextures`.
The per-pass binding loop (`:934-953`) increments `texUnit` over every entry in
`ps.inputTextures` with no bounds check, and `bindImageTextures` (`:471-487`) continues
from there. Past 16: `activeTexture` raises `GL_INVALID_ENUM` (never checked — no
`getError` in the render loop), the bind no-ops, and `uniform1i` with an out-of-range unit
makes the draw fail. Stale or black canvas, silent from the app's side.

The two caps are unconnected: 8 FBOs may exist, but a single composite pass can still want
20 sampler units.

> **Correction (Phase A execution, 2026-09-12).** The mechanism above is **wrong**, and
> measured to be wrong: a fix was implemented, then reverted, and the gates stayed green
> either way. A program declaring more `sampler2D` uniforms than `MAX_TEXTURE_IMAGE_UNITS`
> **does not link** — `getOrCompileProgram` throws and the existing `try/catch` in
> `updateRenderPlan` already returns `{success:false}` with the driver's message. Binding is
> never reached, so the described `GL_INVALID_ENUM`/silent-black path does not occur.
> Verified on Chrome/ANGLE-Metal only; whether link-time enforcement is universal across
> WebGL2 implementations was not established.
>
> **A real bug was found underneath it**, by a different route. In the bind loop
> (`webgl/renderer.ts:1010-1029`) `texUnit++` is **unconditional** — it runs even when
> `ps.uniforms.get(samplerName)` returns nothing. An `inputTextures` entry whose sampler the
> compiler stripped as unused still burns a unit, and `bindImageTextures` then starts from
> an inflated count, walking past the ceiling *after* a program that linked fine. Worst case
> 8 phantom units + 16 image samplers = 24 against a limit of 16.
>
> Not reachable with any shipped node — every texture boundary they create is read. It
> becomes reachable exactly when a node can have a **wired-but-unread texture port**, i.e.
> P0.2 above, which is a Stack property.

### 4. Same-depth siblings silently disable a neighbour's downscale

`resolvePassResolution` pins a whole depth group to full resolution if **any** node in it
fails to declare a scale (`pass-resolution.ts:41-46, 71-72`). A plain gradient layer landing
at the same depth as a pyramid-blur sub-pass silently disables that level's downscale — 4×
the fragments, no warning. Kernel reach stays correct (reference units via
`u_frame_scale`), so it's a perf/quality drift, not a wrong radius.

`verify-pass-resolution.ts` covers a single linear chain only — **no test exists for
convergence, relays, or the `anyFullRes` pin.** Highest-value test to add with Stack.

---

## P2 — breaks loudly, or degrades badly

### 1. Relay passes re-emit everything — O(N²) shader growth

All N layer sources sit at the same depth, but a pass writes one target, so
`groupBoundariesBySourceOutput` (`glsl-generator.ts:286-298`) splits them into 1 primary +
(N−1) relays — and each relay re-emits the **entire body of all N chains**, changing only
the final assignment (`glsl-generator.ts:861`, `902-925`; `ir-compiler.ts:734-752`).

Ten layers = ten passes each containing ten chains. Sixty layers ≈ 3,600 chain bodies,
megabytes of WGSL. **There is no shader-size guard anywhere** in the compiler, worker, or
either renderer.

**This is independent of the accumulate-chain design** — the N *sources* still converge at
depth 0 even when compositing is sequential. Relay pruning (emit only the nodes reachable
to that relay's output) is required either way.

### 2. WebGPU: 16 sampled textures, invalid pipeline, no catchable error

N layers = N `texture_2d` + N `sampler` in one pass; the default limit is 16
(`wgsl-assembler.ts:280-318` puts them all in `@group(1)`). `createRenderPipeline` does not
throw on limit violation — it returns an invalid pipeline and fires an uncaptured
`GPUValidationError`, so the `try/catch` at `webgpu/renderer.ts:594-618` cannot catch it.
There is no `pushErrorScope` or `onuncapturederror` anywhere (only `device.lost` at `:375`).
The draw then issues with group 1 unbound, invalidating the whole command buffer.

Observable at 17+ layers: black/frozen canvas, per-frame validation spam, app reports
success.

**Free win:** `requestDevice()` is called bare everywhere, so you are on **default**
limits, not adapter limits — even a GPU reporting far higher gives 16 unless asked.

> **Correction (Phase A execution, 2026-09-12).** This listed four call sites; there are
> **five**. The missed one is the device-loss recovery request in `setupDeviceLostHandler`
> (`webgpu/renderer.ts:381-382`, once per branch of the timestamp-query ternary) — left
> bare it drops the session back to default limits on the first recovery, exactly when a
> limit-heavy graph is what caused the loss. Full list: `webgpu/renderer.ts:281`,
> `webgpu/renderer.ts:381-382`, `export-engine.ts:86`, `use-export-preview.ts:131`,
> `dev-bridge.ts:431`. Measured on this machine: adapter reports 48 sampled textures per
> stage, a bare request yields a device reporting 16, the fixed path yields 48.

### 3. Intermediate memory is counted in textures, not bytes

Intermediates are full canvas device-pixel size, `rgba8unorm` (`webgpu/renderer.ts:707-712`),
dpr clamped to 2. At 3840×2160 CSS × dpr 2 → **132.7 MB each**. `MAX_INTERMEDIATE_TEXTURES
= 32` therefore permits **~4.25 GB** of render targets. In practice `createTexture` OOMs
first → `device.lost` → the recovery path (`:375-400`) requests a fresh device and
**re-applies the same plan**, which OOMs again: a device-loss loop with no backoff and no
crash counter.

Under the accumulate-chain design this only improves if the renderer gains **liveness-based
texture reuse** — today it allocates one texture per pass index with no aliasing
(`webgpu/renderer.ts:709`, `webgl/renderer.ts:359-387`), so a 2N-pass chain still allocates
2N textures.

### 4. Main-thread freeze after compilation

The compile worker has a 10 s watchdog that restarts it with a visible message
(`use-live-compiler.ts:308-322`) — clean. But once the plan returns,
`createShaderModule` + `createRenderPipeline` × N run **synchronously on the main thread**
in `updateMultiPass`, with no watchdog. A many-pass plan with large shaders is an unbounded
freeze: no spinner, browser "page unresponsive".

Related: the worker is shared with previews (`compiler.worker.ts:120-147`), so a 9 s Stack
compile stalls every thumbnail in the graph and trips the preview scheduler's own 10 s
sweep (`preview-scheduler.ts:419`).

### 5. Preview guard bounds the wrong quantity

`MAX_PREVIEW_PASSES = 6` counts `passPartition.length` — **depth groups**
(`ir-subgraph-compiler.ts:32,101`; `subgraph-compiler.ts:27`) — and is checked *before*
relay expansion. A 60-layer Stack has depth 2, sails through, and compiles 61 preview
passes. When the guard does fire, `depthExceeded` has **no consumer** anywhere in
`src/components` or `src/nodes`: the thumbnail just stays blank or stale forever, with only
a `console.warn`. The WebGL preview program cache (`MAX_CACHE = 64`) thrashes on a single
node.

---

## P3 — lifecycle and correctness papercuts

1. **Undo splits in two.** `onEdgesChange` pushes history without clearing `_lastActionKey`
   (`graphStore.ts:182-197`), unlike `addNode`/`removeNode`. Removing a port yields two
   entries: one undo restores the port but **not** its wire. Already true for `arithmetic`;
   Stack makes it constant, since every layer removal is an edge+param pair. `removeElements`
   (`:241-267`) exists as the atomic pattern to copy.
2. **Param edits coalesce for 800 ms** keyed `param:<nodeId>` (`:274-294`) — "add layer,
   set opacity" collapses into one undo entry that discards both.
3. **In-place array mutation corrupts the whole undo stack.** Snapshots are shallow
   (`:97-99`), sound only because every mutation path is immutable. `layers[i].x = y`,
   `.splice`, `.sort` would alias across all 50 snapshots. `ColorRampEditor` is careful
   about this (`:203`, `:229`, `:290`); a Stack editor must be too.
4. **`defaultParamsFor` is shallow** (`FlowCanvas.tsx:66-72`) — every Stack node aliases the
   registry's default array. One in-place edit poisons all future Stack nodes for the
   session. Knock-on: `encodeCompactHash` strips defaults via `deepEqual`, which
   short-circuits on identity (`sombra-file.ts:486`, `530-539`), so while the array is still
   the shared reference **the entire layer list is omitted from the share URL**.
5. **`dynamicParams` would be invisible to change detection.** `semanticKey` and
   `uniformKey` iterate `def.params` only (`use-live-compiler.ts:234-264`), as do
   `collectCurrentUniformValues` (`:88-113`) and both backends' uniform emission
   (`ir-compiler.ts:241-256`, `glsl-generator.ts:540-550`). Five places; miss one and adding
   a layer dispatches no recompile.
6. **`migrate` is not a safety net.** It prunes dangling handles and is dynamic-aware
   (`graphStore.ts:469`), but zustand only runs it when the persisted version differs from
   `GRAPH_SCHEMA_VERSION` — i.e. **never in normal use**. Orphaned edges persist
   indefinitely, then get validated against a different layer at the next schema bump.
7. **Cycles are diagnosed, not prevented.** `isValidConnection` (`FlowCanvas.tsx:252-281`)
   checks existence and type only — no reachability. All compile entry points call
   `hasCycles` and surface an error, but `topologicalSort` itself has no cycle detection
   (`topological-sort.ts:59-80`) and returns a mis-ordered list. Stack makes cycles far
   easier to draw; add the check to `isValidConnection`.
8. **Share URLs have no size budget** — no length check, warning, or truncation anywhere
   (`sombra-file.ts:552-556`). Layer metadata is cheap, but `imageData` is a param and is
   always inlined, so a Stack fed by many images produces a multi-megabyte URL. Pre-existing,
   but Stack makes many-image graphs normal.
9. **Zero-layer Stack.** No boundaries → possibly single-pass → the node may emit no
   assignment to its output var while downstream references it: invalid shader that passes
   the compiler's error check and fails at GPU link. Emit an explicit transparent constant.
10. **Coordinate base flips on first wire.** With zero layers wired `isTextureMode` is
    false and `auto_uv` inputs use pattern space; wiring the first layer switches them to
    screen UV (`glsl-generator.ts:326-336`, `485-490`).

---

## Things that are already correct

Worth recording so nobody re-litigates them:

- **Fan-out to several layers** produces one physical pass, not N. Boundaries group by
  `${source}:${sourceHandle}` (`glsl-generator.ts:286-298`) and share a compiled index
  (`:889-891`). Cost is one sampler unit per boundary — dedup is an optimisation, not a bug.
- **Mixed-depth convergence binds correctly.** One texture per compiled pass index, no
  ping-pong aliasing; `samplerCompiledIndex` translates partition→compiled index so relays
  address the right target. A depth-0 layer survives to a depth-6 read.
- **Coordinates are per-node, not per-port** — one `screen_uv` variable is shared by all
  layers, so every layer samples on an identical base. `fragCoord('native')` is the correct
  orientation for texture reads; Stack declares no `spatial`, so the SRT block is skipped.
  No Y-flip hazard.
- **Partial wiring** is sound in both backends provided every layer port declares a
  `default` — otherwise it's a hard compile error (`glsl-generator.ts:494-497`).
- **Deleting an upstream node** is clean: `onBeforeDelete` routes to `removeElements`, which
  drops node and edges in one snapshot; the layer falls back to its default and stays in the
  list as an empty slot.
- **Nested Stacks** compose — depth is just `max(sourceDepth+1)`.

---

## What this changes about the plan

1. **Stable per-layer ids** replace index-keyed ports. (P1.1)
2. **Accumulate in a chain** rather than converging N textures into one pass — removes the
   16-sampler wall and cuts live-texture pressure. Chosen 2026-09-11.
3. **Relay pruning is required regardless** — the accumulate design does not avoid it,
   because the N *sources* still converge at depth 0. (P2.1)
4. **Liveness-based texture reuse** is what actually makes layer count unbounded; without
   it a 2N-pass chain still allocates 2N full-size targets. (P2.3)
5. **Promote the WebGL2 over-cap warning to a visible error** before anything else ships —
   it is a pre-existing silent-wrong-output bug that Stack turns from exotic into routine.
   (P1.2)
6. **Request adapter limits** in `requestDevice()`. One line, raises the sampler ceiling.
7. **New verification gate for convergence** — pass count, `inputTextures` indices, and the
   `anyFullRes` pin. None of this is covered today.

Items 5 and 6 are independent of Stack and should land first as their own commits — they
fix existing bugs.
