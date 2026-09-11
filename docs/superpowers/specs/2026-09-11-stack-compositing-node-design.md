# Stack — compositing node

**Date:** 2026-09-11 · **Status:** design approved, spec under review · **Author:** Nikita + Claude
**Revision 2** — rewritten after the failure-mode audit
(`docs/audit/2026-09-11-stack-node-failure-modes.md`). Changes from revision 1 are listed
in §12.

A layering node: N image inputs composited bottom-up, each layer carrying its own blend
mode, opacity and mask. Replaces `mix` as the way two or more images are combined, and
gives Sombra the Photoshop-style compositing it has never had.

---

## 1. Why

`mix` is the entire blend surface today: one `mix(a, b, factor)` over the full vec4
(`src/nodes/math/mix.ts`). It lerps alpha along with colour, offers no modes, and handles
exactly two inputs. There is no blend, composite, over, layer or mask node anywhere in
`src/nodes/`. Anything resembling a comp is built by hand out of math nodes.

`PHASE6-MULTIPASS.md:485` anticipated this node by name.

## 2. What a Stack is

An ordered list of layers, composited **bottom-up** — layer 1 is the bottom. Each layer:

| Control | Kind | Notes |
|---|---|---|
| **Source** | `color` port, `textureInput: true` | A whole upstream branch, rendered to its own pass — so a layer may itself contain blur, pixelate or any multi-pass effect. |
| **Blend mode** | enum, `recompile` | 22 modes (§5). **Greyed on the bottom layer** — nothing beneath to blend against. |
| **Opacity** | float, `uniform`, `connectable` | Slider plus handle. Drag hits the uniform fast path; never recompiles. |
| **Mask** | float, `connectable` | Handle only. Unconnected = 1.0. Same pass as its composite step — costs no extra boundary. |
| **Visible** | bool, `recompile` | Eye toggle. Hidden layer is dropped from codegen entirely. |

Opacity and mask are deliberately **separate controls** even though they multiply into the
same term. The driving case: set a layer to 0.5 opacity *and* cut through it with a noise
mask. Collapsing them would force an upstream multiply node for a common operation.

An unwired Source is fully transparent and contributes nothing, so empty slots are free.

### Layer identity

Layers carry **stable ids** (`layer_<uuid>`), minted once at creation and never reused.
Ports are named from the id, never from the array index.

This is a correctness requirement, not a preference. Nothing in the codebase rewrites
`edge.targetHandle` — not the store, not persist, not the `.sombra` importer — and port
resolution is a plain string match (`ir-compiler.ts:169`, `glsl-generator.ts:444`). With
index-named ports, deleting layer 1 of 4 makes the wire on `layer_2` resolve against the
new `layer_2`, i.e. the old layer 3: **wrong image on wrong layer, silently**. Reorder has
the same shape. `arithmetic` never hit this because it only appends and removes from the
tail (`ShaderNode.tsx:122-144`).

## 3. Compositing maths

Straight (non-premultiplied) alpha throughout, matching the rest of the graph;
premultiplication happens once, at Fragment Output's last line. Per layer, over the
accumulated backdrop `(c_b, a_b)`:

```
a_s  = src.a × opacity × mask               // effective coverage
c_s' = (1 - a_b)·c_s + a_b·B(c_b, c_s)      // blend applies only where backdrop exists
a_o  = a_s + a_b·(1 - a_s)                  // alpha-aware over
c_o  = ((1 - a_s)·a_b·c_b + a_s·c_s') / a_o // guarded divide, a_o == 0 → 0
```

The PDF/Photoshop model. `B` is the only part that varies per mode.

**Alpha rule.** `NODE_AUTHORING_GUIDE.md:529-537` forbids mask/effect primitives from
writing computed values into alpha. Stack is a **blend**, not a mask primitive — under the
taxonomy in `docs/superpowers/plans/rgba-node-audit.md` a blend legitimately computes alpha.
State this in the file header so a reviewer does not read it as a violation.

**Blend space.** sRGB by default, matching Photoshop and Figma. A node-level enum switches
to linear light. Helpers already exist and are used by all three blurs (`sombra_toLin` /
`sombra_toSrgb`, `src/nodes/shared/color-space.ts`).

**Input range.** Blend modes assume [0,1]. Upstream nodes can emit negatives or values
above 1, and `toLin()` on a negative is NaN. Clamp each layer's colour to [0,1] on entry,
and clamp opacity and mask likewise. Note this is partly moot between layers: intermediate
passes store `rgba8unorm`, so anything outside [0,1] is already clipped at the pass
boundary — **additive glow does not survive a Stack the way it survives inline**. Document
that; do not try to defeat it.

**Degenerate guards.** Colour Dodge / Colour Burn / Divide produce Inf or NaN at their
denominators; every mode helper is responsible for its own guard. A zero-layer Stack must
emit an explicit transparent constant, or it assigns nothing to its output variable while
downstream references it — invalid shader that passes the compiler's error check and fails
at GPU link.

## 4. Architecture: accumulate in a chain

**Rejected: convergence.** The obvious shape — N texture inputs meeting in one pass — does
not survive the renderers. N layers means N sampled textures in the final pass, against a
default WebGPU limit of 16; past that `createRenderPipeline` returns an *invalid* pipeline
without throwing, the `try/catch` at `webgpu/renderer.ts:594` cannot catch it, and the draw
issues with an unbound group, invalidating the whole command buffer. WebGL2 fails earlier
and worse — see §7.

**Chosen: a chain.** Stack declares `multiPass` with `count = layers.length`. Sub-pass *k*
composites layer *k* onto the running result, reading the previous sub-pass through a
dedicated `backdrop` texture port. Two samplers per pass regardless of layer count, shader
size linear in N, and live-texture pressure bounded once §6.3 lands.

`multiPass` already carries what is needed: `count(params)`, `from`/`to` port names, and
`resolution(passIndex)`; the generator reads its index from `params.__subPass`
(`src/nodes/types.ts:337-352`, `expand-passes.ts:27`).

Two extensions to `expand-passes.ts` are required, both small and both opt-in:

1. **Expansion must not require a wired chain input.** Today expansion is skipped when the
   `to` port has no incoming edge (`expand-passes.ts:71-73`) — sensible for blur, fatal
   here: Stack's `backdrop` is wired by the expansion itself, never by the user. Sub-pass 0
   composites layer 0 over *transparent*, which is exactly right. Needs an explicit opt-out
   on the `multiPass` declaration rather than a behaviour change for every node.
2. **Per-sub-pass edge routing.** Today every non-chain incoming edge is duplicated onto
   every sub-pass (`expand-passes.ts:104-113`) — correct for blur, where a connectable
   radius must reach both axes. For Stack it would bind **all N layer textures into all N
   sub-passes**, recreating the exact sampler explosion the chain exists to avoid. The node
   must be able to say which incoming edges belong to which sub-pass: layer *k*'s source,
   opacity and mask go to sub-pass *k*; nothing else does.

**What the chain does NOT fix.** The N layer *sources* are still independent branches at
pass depth 0, and one pass writes one target, so they still split into 1 primary +
(N−1) relay passes — and each relay re-emits **the entire body of all N chains**
(`glsl-generator.ts:861`, `902-925`; `ir-compiler.ts:734-752`). Shader text grows O(N²)
regardless of how compositing is sequenced. **Relay pruning is therefore mandatory, not an
optimisation** (§6.4).

Cost summary at N layers, after all enablers: ~2N passes (N sources + N composites), 2
samplers per pass, ~3 live intermediates, shader size O(total graph).

## 5. Blend modes (22)

**Separable** (per channel): Normal, Darken, Multiply, Colour Burn, Linear Burn, Lighten,
Screen, Colour Dodge, Linear Dodge (Add), Overlay, Soft Light, Hard Light, Vivid Light,
Linear Light, Pin Light, Hard Mix, Difference, Exclusion, Subtract, Divide.

**Non-separable** (whole colour): Hue, Saturation, Colour, Luminosity — these need the
`ClipColor` / `SetLum` / `SetSat` helpers from the PDF spec.

**No runtime branch.** Each layer's mode is a compile-time enum, so codegen emits only the
helper that layer actually uses; the shader contains only the modes present in the graph,
not all 22. `ifStmt` is not needed for mode selection, and the WGSL
non-uniform-branch hazards do not arise. Helpers are shared via `ctx.addFunction`, so
repeated modes cost one definition.

**Zero hand-written two-arg `raw(glsl, wgsl)`** — the library-wide budget is 0.

## 6. Framework changes

Ordered by dependency. Each is its own commit.

### 6.1 Dynamic texture ports are silently broken *(P0)*

`partitionPasses`' quick-check (`glsl-generator.ts:156`) and `findTextureBoundaries`
(`:255`) iterate `def.inputs`; only the depth loop between them resolves `dynamicInputs`
(`:180-182`). A dynamically-declared texture port therefore raises pass depth but never
receives a sampler. Both helpers are shared by all four compilers
(`glsl-generator.ts:665,749`, `ir-compiler.ts:513,587`, `subgraph-compiler.ts:92,178`,
`ir-subgraph-compiler.ts`), so one fix covers main and preview on both backends.

### 6.2 `dynamicParams` *(P0 for per-layer opacity)*

`NodeDefinition.params` is a static array (`src/nodes/types.ts:270`). Without a dynamic
counterpart, per-layer opacity cannot be a real uniform, and baking it as an IR literal
would make every drag a recompile — violating the animatable-slider rule from the blur work.

Add `dynamicParams?: (params) => NodeParameter[]`, resolved in **all five** places that
iterate `definition.params` today, or adding a layer dispatches no recompile at all:

- `semanticKey` and `uniformKey` — `use-live-compiler.ts:234-264`
- `collectCurrentUniformValues` — `use-live-compiler.ts:88-113`
- uniform emission, IR — `ir-compiler.ts:241-256`
- uniform emission, GLSL — `glsl-generator.ts:540-550`
- param rendering — `ShaderNode.tsx:273`

Uniform *count* is not a concern: 60 opacity + 60 mask floats is 480 bytes against a 64 KiB
uniform-buffer limit.

### 6.3 Liveness-based intermediate reuse

Both renderers allocate one texture per pass index with no aliasing
(`webgpu/renderer.ts:709`, `webgl/renderer.ts:359-387`), so a 2N-pass chain still allocates
2N full-size targets. At 4K/dpr2 each is 132.7 MB. A chain's textures are short-lived — a
source is dead after its composite step — so a liveness pass over the RenderPlan can reuse
them. **This is what actually makes layer count unbounded.** Until it lands, the effective
ceiling is the intermediate cap (§7).

Replace `MAX_INTERMEDIATE_TEXTURES` (a count) with a **byte** budget while here: 32 textures
permits ~4.25 GB at 4K, and the OOM path requests a fresh device and re-applies the same
plan (`webgpu/renderer.ts:375-400`) — a device-loss loop with no backoff.

### 6.4 Relay pruning

Each relay pass must emit only the nodes reachable to *its* output, not the whole pass body.
Without this, shader size is O(N²) in converging branches (§4).

### 6.5 `expand-passes` extensions

The two opt-ins described in §4.

### 6.6 Chrome and interaction

- **`portsRenderedByComponent`.** Every port's handle is drawn by the generic chrome
  (`ShaderNode.tsx:385-408`); no node has ever drawn its own, and there is no opt-out, so
  handles in rows would duplicate handle ids. Add a general flag rather than another
  node-specific branch (precedent: `color_constant` at `:304-309`). Handle ids must equal
  port ids or edges silently drop on reload.
- **Suppress the generic `+`/`−` row**, which is hardwired to a param named `inputCount`
  and `in_${i}` edge names with min 2 / max 8 baked in (`ShaderNode.tsx:411-433`).
- **`updateNodeInternals` is called nowhere in the repo.** React Flow v12 needs it when a
  node's handles change after mount. Add/remove changes node height so the ResizeObserver
  likely covers it, but **reorder moves handles without changing size** — the case a
  size-based re-measure cannot catch. Expect wires to stay at stale positions after a
  reorder unless this is called.

### 6.7 Store atomicity

- Layer mutation must be **one store action** that writes `params` and prunes/remaps edges
  in a single `set`. Today `onEdgesChange` pushes history without clearing `_lastActionKey`
  (`graphStore.ts:182-197`), unlike `addNode`/`removeNode`, so removing a port yields two
  entries and one undo restores the port but not its wire. `removeElements` (`:241-267`) is
  the pattern to copy. This bug is live in `arithmetic` today.
- **Strip edges to removed layer ports on the param change**, not only on file load and
  schema migration. Otherwise a wired-but-unread port makes `createBindGroup` throw
  (swallowed at `webgpu/renderer.ts:800-809`), the draw issues with group 1 unbound, and the
  whole command buffer is invalidated — WebGPU black, WebGL2 fine. Reachable by simply
  lowering the layer count with wires attached.
- **Never mutate the layer array in place.** Undo snapshots are shallow
  (`graphStore.ts:97-99`), sound only because every mutation path is immutable;
  `layers[i].x = y` / `.splice` / `.sort` would alias across all 50 snapshots.
  `ColorRampEditor` models the discipline (`:203`, `:229`, `:290`).
- **`defaultParamsFor` is shallow** (`FlowCanvas.tsx:66-72`) — every Stack node would alias
  the registry default array, and `encodeCompactHash` strips params equal to default via a
  `deepEqual` that short-circuits on identity (`sombra-file.ts:486`, `530-539`), so the whole
  layer list would be **omitted from share URLs**. Deep-clone defaults.

### 6.8 Stack's own codegen contract

Emit a sample for **every** sampler present in `ctx.textureSamplers`, including ones the
layer loop ignores — an emitted-but-unread binding is the P0 above. Give every layer port an
explicit `default` of `[0,0,0,0]`, or an unwired port is a hard compile error
(`glsl-generator.ts:494-497`).

## 7. Pre-existing bugs to fix first

Independent of Stack; Stack turns both from exotic into routine.

- **WebGL2 over-cap renders the wrong texture and reports success.** Desktop cap is 8
  intermediates, mobile 4 (`webgl/renderer.ts:129-131`, `191-207`). Over it: a
  `console.warn` (`:363-366`), `success:true` (`:557`), passes skipped (`:922-923`), and
  their sampler uniforms **never set** — so they sample whatever is on texture unit 0. A
  9-layer Stack shows layers 9+ as duplicates of layer 1. A **3-layer** Stack over a pyramid
  blur (7 passes) already reaches the cap. Return `{success:false}`; the path to the UI
  exists (`App.tsx:75-86`).
- **`requestDevice()` is called bare**, pinning every session to *default* limits rather
  than adapter limits. **Five sites, not four** — `webgpu/renderer.ts:281`,
  `export-engine.ts:86`, `use-export-preview.ts:131`, `dev-bridge.ts:431`, and the one the
  audit missed: the device-loss recovery request in `setupDeviceLostHandler`
  (`webgpu/renderer.ts:381-382`, once per branch of the timestamp-query ternary). Leaving
  that one bare drops the session back to default limits on the first recovery — precisely
  when it hurts most, since device loss on a limit-heavy graph is what triggers it.

  Measured on this machine (Chrome): the adapter reports
  `maxSampledTexturesPerShaderStage` **48**, a bare `requestDevice()` yields a device
  reporting **16**, and the fixed path yields **48**. The ceiling is genuinely 3× higher,
  not a descriptor that merely looks right. `maxSamplersPerShaderStage` stays 16 on this
  adapter because 16 is what it reports.

  This does not change the §4 architecture decision: the raised ceiling is per-device and
  WebGL2 is unaffected (8 intermediates, 16 texture units), so a convergence design would
  still be unportable. It does mean the *interim* layer cap on WebGPU can be higher than
  originally assumed — derive it from live device limits (§14), not a constant.

Two more worth doing alongside, both cheap:

- **Cycle check in `isValidConnection`** (`FlowCanvas.tsx:252-281`), which today checks
  existence and type only. Compilation catches cycles, but `topologicalSort` itself does not
  (`topological-sort.ts:59-80`). Stack makes cycles far easier to draw.
- **`pushErrorScope('validation')` around `createRenderPipeline`**, since WebGPU limit
  violations are not throwable and there is no `onuncapturederror` anywhere.

## 8. Data model

One hidden, `recompile` param holds the layer list — the `gradient.ts` / `color-ramp.ts`
stops mechanism (`type:'float', default:0, hidden:true, updateMode:'recompile'`, with the
real array in `node.data.params`). It persists free: `NodeData.params` is
`Record<string, unknown>`, and both localStorage and `.sombra` serialise it wholesale.

```ts
interface StackLayer {
  id: string             // stable, uuid, never reused — ports derive from this
  blendMode: BlendMode   // baked
  visible: boolean       // baked; false → layer omitted from codegen
  // opacity and mask are dynamicParams uniforms, keyed from id
}
```

Ports derive from the array:
`dynamicInputs: (params) => layers.map(l => ({ id: `layer_${l.id}`, type: 'color', textureInput: true, default: [0,0,0,0] }))`,
plus the `backdrop` chain port.

Keep heavy data out of `layers` — `semanticKey` JSON-stringifies it on every keystroke
(`use-live-compiler.ts:245`).

## 9. UI

**Design-first. Figma → local sandbox → sign-off → production swap.** Nothing below is a
visual decision.

Settled anatomy (agreed 2026-09-11):

- Node body is a layer list. **Top row = topmost layer**, Photoshop order.
- A list header — quiet "Layers" label with `＋` at the right — sits **above** the cards.
  New layers land on top, so affordance and result share a location.
- Each layer is a card of **three lines**, one handle per line, each beside the control it
  drives: Source on the blend-mode line, opacity on the slider line, mask on the mask line.
- **Unconnected float handles read hollow, wired ones filled** — the only at-a-glance cue
  for which layers are driven from elsewhere. Apply consistently or it is noise.
- Blend mode is greyed on the bottom layer; its mask stays live. Grey **only the dropdown** —
  CSS opacity on a row composites the whole subtree, and the Source handle and eye must stay
  at full strength.
- **No compaction.** Full-size rows at any count; the node grows. No dense variant, no
  scroll-inside-node, no virtualisation.
- Reorder is drag — rest / hover / grabbed / drop-target / released all need designing.
  Pointer-capture on a custom control, never a native `<input type="range">`.
- Icons from the owned lucide set via `npm run icons:add`.

## 10. Verification

Registry-driven gates sweep the node up automatically: `self-validate`,
`verify-srt-conformity`, `verify-raw-budget`, `verify-coord-hygiene`. Three need manual work:

- `verify-wired-texture-branch.ts:31` tests only a node's **first** texture port.
- `validate-wgsl-multipass.ts` draws from a hardcoded `TEXTURE_NODES` array.
- `verify-ir-poc.ts` fixtures are hand-written.

**A new convergence gate is the highest-value addition.** `verify-pass-resolution.ts`
covers a single linear chain only — nothing tests convergence, relays, or the `anyFullRes`
pin, where any non-declaring node in a depth group pins the whole group to full resolution
(`pass-resolution.ts:41-46`, `71-72`), silently disabling a pyramid sub-pass's downscale
when a plain gradient layer lands beside it.

**Every gate needs a mechanism-engaged assertion.** A pixel diff passes perfectly when the
blend is skipped entirely, because the output then equals the backdrop. Assert pass count,
bound-texture count, and that the selected mode's helper appears in the emitted shader —
then perturb the implementation and confirm the gate fails.

Exercise all 22 modes, both blend spaces, and every wiring combination including the
partially-wired case. Defaults prove least.

## 11. Commit sequence

**Phase A — existing bugs, independent of Stack**

| # | Commit |
|---|---|
| A1 | `fix(webgl): fail the plan when intermediates exceed the cap` |
| A2 | `fix(webgpu): request adapter limits instead of defaults` |
| A3 | `fix(canvas): reject connections that would create a cycle` |

**Phase B — framework enablers**

| # | Commit |
|---|---|
| B1 | `fix(compiler): resolve dynamicInputs when finding texture boundaries` (§6.1) |
| B2 | `test(verify): cover every texture port, not just the first` |
| B3 | `feat(compiler): dynamicParams, the per-instance counterpart to dynamicInputs` (§6.2) |
| B4 | `perf(compiler): relay passes emit only their own reachable nodes` (§6.4) |
| B5 | `feat(compiler): per-sub-pass edge routing and sourceless chain expansion` (§6.5) |
| B6 | `perf(renderer): reuse intermediates by liveness` (§6.3) |

**Phase C — the node**

| # | Commit |
|---|---|
| C1 | `feat(nodes): blend-mode helper library` — 22 modes, both backends, verified standalone |
| C2 | `feat(nodes): stack compositing node` — chain codegen + layer model. Verifiable via `window.__sombra.setParams`; **not human-usable**, the layer list has no generic UI |
| C3 | `feat(compiler): convergence verification gate` (§10) |

**Phase D — the UI**

| # | Step |
|---|---|
| D1 | Figma: layer row, list header, all reorder states |
| D2 | Sandbox harness, real React on real tokens — sign-off here |
| D3 | DS pipeline: `sombra.ds.json` → `npm run tokens` → `ds.*` → `tokens:audit` |
| D4 | `feat(ui): stack layer list editor` — `portsRenderedByComponent`, atomic layer store action, `updateNodeInternals` |

**Staging.** Stack can ship before every enabler lands, with a layer cap that rises as they
do: ~4 without B4/B6 on WebGL2, higher on WebGPU after A2, unbounded after B6. Pick the cap
from the *measured* ceiling, not the hoped-for one, and make exceeding it a visible error
rather than a silent wrong image.

## 12. Changes from revision 1

- Architecture switched from **convergence to an accumulate chain** (§4).
- **Stable layer ids** are now a requirement — index-keyed ports silently mis-assign images.
- **Blend modes need no runtime branch**; revision 1 specced an `ifStmt` chain unnecessarily.
- Added §6.3 liveness reuse, §6.4 relay pruning, §6.5 expand-passes extensions, §6.7 store
  atomicity, §7 pre-existing bugs.
- Added input-range clamping and the RGBA8 clipping caveat (§3).
- Commit sequence regrouped into phases; count rose from 9 steps to 16.

## 13. Out of scope

- **Per-layer alpha operators** — they fight the alpha-aware `over` in §3.
- **Texture masks** — mask is a connectable float in its layer's composite pass.
- **Layer groups, clipping masks, adjustment layers.**
- **Inlining cheap layer sources** to avoid a pass. There is no inlining path for a
  `textureInput` today; every layer costs a full-canvas target even for a constant colour.

## 14. Open questions

- Whether hidden layers drop their upstream pass (cheaper to render) or keep it (cheaper to
  toggle). Leaning drop — `visible` is already recompile.
- Whether blend space belongs on the node or should follow the document.
- Whether the layer cap should be derived at runtime from the live device limits rather
  than a constant.
