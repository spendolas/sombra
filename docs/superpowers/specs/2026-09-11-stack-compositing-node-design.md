# Stack — compositing node

**Date:** 2026-09-11 · **Status:** design approved, spec under review · **Author:** Nikita + Claude

A layering node: N image inputs composited bottom-up, each layer carrying its own blend
mode, opacity and mask. Replaces `mix` as the way two or more images are combined, and
gives Sombra the Photoshop-style compositing it has never had.

---

## 1. Why

`mix` is the entire blend surface today: one `mix(a, b, factor)` over the full vec4
(`src/nodes/math/mix.ts`). It lerps alpha along with colour, offers no modes, and handles
exactly two inputs. There is no blend, composite, over, layer or mask node anywhere in
`src/nodes/`. Anything resembling a comp is built by hand out of math nodes.

`PHASE6-MULTIPASS.md:485` anticipated this node by name:

> **Multiple texture inputs on one node**: Each wired `textureInput` produces its own
> upstream pass. Future node (e.g., blend/composite) could have two texture inputs from
> different sources.

## 2. What a Stack is

An ordered list of layers, composited **bottom-up** — layer 1 is the bottom. Each layer:

| Control | Kind | Notes |
|---|---|---|
| **Source** | `color` port, `textureInput: true` | A whole upstream branch, rendered to its own pass — so a layer may itself contain blur, pixelate or any multi-pass effect. |
| **Blend mode** | enum, `recompile` | 22 modes (§4). **Greyed on the bottom layer** — nothing beneath to blend against. |
| **Opacity** | float, `uniform`, `connectable` | Slider plus handle. Drag hits the uniform fast path; never recompiles. |
| **Mask** | float, `connectable` | Handle only. Unconnected = 1.0. Same pass as Stack — costs no extra boundary. |
| **Visible** | bool, `recompile` | Eye toggle. Hidden layer is dropped from codegen entirely. |

Opacity and mask are deliberately **separate controls** even though they multiply into the
same term. The driving case: set a layer to 0.5 opacity *and* cut through it with a noise
mask. Collapsing them into one port would force an upstream multiply node for a common
operation — elaborate, imprecise, and confusing to read back off the canvas.

An unwired Source is fully transparent and contributes nothing, so empty slots are free.

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

This is the PDF/Photoshop model. `B` is the only part that varies per mode, which is why
22 modes cost one shared helper library rather than 22 special cases. Stacking
semi-transparent layers gives the same result as Photoshop; a naive `mix` does not.

**Alpha rule.** `NODE_AUTHORING_GUIDE.md:529-537` forbids mask/effect primitives from
writing computed values into alpha. Stack is a **blend**, not a mask primitive — under the
RGBA taxonomy in `docs/superpowers/plans/rgba-node-audit.md` a blend legitimately computes
alpha. State this in the file header so a later reviewer does not read it as a violation.

**Blend space.** sRGB by default, matching Photoshop and Figma so a comp can be eyeballed
against a mock. A node-level enum switches to linear light for physically-correct glow.
The conversion helpers already exist and are already used by all three blurs
(`sombra_toLin` / `sombra_toSrgb`, `src/nodes/shared/color-space.ts`).

## 4. Blend modes (22)

**Separable** (per channel): Normal, Darken, Multiply, Colour Burn, Linear Burn, Lighten,
Screen, Colour Dodge, Linear Dodge (Add), Overlay, Soft Light, Hard Light, Vivid Light,
Linear Light, Pin Light, Hard Mix, Difference, Exclusion, Subtract, Divide.

**Non-separable** (whole colour): Hue, Saturation, Colour, Luminosity — these need the
`ClipColor` / `SetLum` / `SetSat` helpers from the PDF spec.

All built from `ifStmt` (`src/compiler/ir/types.ts:437`) plus structured builders. **Zero
hand-written two-arg `raw(glsl, wgsl)`** — the library-wide budget is 0 and the ratchet
only moves down. Mode selection is a compile-time enum, so the branch condition is
quad-uniform and the WGSL `textureSample`-in-non-uniform-branch trap does not apply.

## 5. Framework changes

Two gaps block the node. Each lands as its own commit, ahead of it.

### 5.1 Dynamic texture ports are silently broken

Pass partitioning resolves `dynamicInputs` when computing depth
(`glsl-generator.ts:180-182`) but **not** when detecting or binding texture boundaries:

- `glsl-generator.ts:157` — `partitionPasses` quick-check iterates `def.inputs`
- `glsl-generator.ts:256` — `findTextureBoundaries` iterates `def.inputs`

A dynamically-added `textureInput` therefore raises pass depth but never receives a
sampler: the emitted shader references a sampler that was never bound. Both functions are
shared by all four compilers — `glsl-generator.ts:665,749`, `ir-compiler.ts:513,587`,
`subgraph-compiler.ts:92,178`, `ir-subgraph-compiler.ts` — so one fix covers main and
preview on both backends.

**Fix:** resolve `dynamicInputs` in both loops, mirroring line 180.

### 5.2 Params cannot vary per layer

`NodeDefinition.params` is a static array (`src/nodes/types.ts:270`); there is no
`dynamicParams` counterpart to `dynamicInputs`. Without it, per-layer opacity cannot be a
real `uniform` param, and baking it as an IR literal (the gradient-stops approach) would
make every opacity drag a recompile — violating the animatable-slider rule established
during the blur work.

**Fix:** add `dynamicParams?: (params) => NodeParameter[]`, resolved everywhere
`definition.params` is iterated today: `ShaderNode.tsx:273`, `ir-compiler.ts:208-209,
242-243`, the GLSL equivalent, and the uniform-key computation in `use-live-compiler.ts`.
Per-layer opacity then behaves exactly like any other connectable uniform param —
animatable, drivable, no recompile on drag — with no cap on layer count.

Rejected alternatives: a fixed pool of 16 pre-declared slots (caps layers, emits unused
uniforms); opacity as a plain input port (forces a Float node for the common case).

## 6. Data model

One hidden, `recompile` param holds the layer list — the `gradient.ts` / `color-ramp.ts`
stops mechanism (`type: 'float', default: 0, hidden: true, updateMode: 'recompile'`, with
an arbitrary array living in `node.data.params`). It persists free: `NodeData.params` is
`Record<string, unknown>`, and both localStorage and `.sombra` serialise it wholesale.

```ts
interface StackLayer {
  blendMode: BlendMode   // enum value, baked
  visible: boolean       // baked; false → layer omitted from codegen
  // opacity is NOT here — it is a dynamicParams uniform, keyed opacity_<i>
}
```

Ports derive from the array, not from a separate count:
`dynamicInputs: (params) => layers.map((_, i) => ({ id: `layer_${i}`, type: 'color', textureInput: true, default: [0,0,0,0] }))`.

Note the generic `+`/`−` row in `ShaderNode.tsx:411-433` is hardwired to a param named
`inputCount` and to `in_${i}` edge names, with min 2 / max 8 baked into the component. It
renders whenever `dynamicInputs` is present and cannot be opted out of — Stack needs it
suppressed, which is part of the step-8 chrome change.

## 7. UI

**Design-first. Figma → local sandbox → sign-off → production swap.** Nothing below is a
visual decision; those are made in Figma against the DS, then proven in `src/sandbox/`.

Settled anatomy (schematic agreed 2026-09-11):

- The node body is a layer list. **Top row = topmost layer**, Photoshop order.
- A list header — quiet "Layers" label with a `＋` at the right — sits **above** the
  cards. New layers land on top, so the affordance and its result share a location, and
  the button does not drift as the stack grows.
- Each layer is a card of **three lines**, one handle per line, each beside the control it
  drives: Source handle on the blend-mode line, opacity handle on the slider line, mask
  handle on the mask line. Unconnected float handles read as hollow.
- Blend mode is greyed on the bottom layer; its mask stays live.
- **No compaction.** Full-size rows at any layer count — the canvas is infinite, so the
  node simply grows. No dense variant, no scroll-inside-node, no virtualisation.
- Reorder is drag, which exists nowhere in the repo yet: rest / hover / grabbed /
  drop-target / released all need designing. Pointer-capture drag on a custom control —
  never a native `<input type="range">`, per the standing rule.
- Icons (drag grip, eye) come from the owned lucide set via `npm run icons:add`.

**Chrome change.** Every port's handle is drawn by the generic chrome
(`ShaderNode.tsx:385-408`); no node has ever drawn its own, and there is no "the component
renders this port's handle" opt-out — so handles in rows would duplicate handle ids. Add a
general `portsRenderedByComponent` flag rather than another node-specific branch (there is
precedent in the `color_constant` special-case at `:304-309`). Handle ids must equal port
ids or edges silently drop on reload.

## 8. Verification

Registry-driven gates sweep the node up automatically: `self-validate` (wires every
declared input, enumerates every enum variant), `verify-srt-conformity`,
`verify-raw-budget`, `verify-coord-hygiene`. Three need manual work or Stack is skipped:

- `verify-wired-texture-branch.ts:31` does `def.inputs.find(i => i.textureInput)` — only a
  node's **first** texture port is ever compiled. Widen to all ports (own commit, §9).
- `validate-wgsl-multipass.ts` draws from a hardcoded `TEXTURE_NODES` array — add entries.
- `verify-ir-poc.ts` fixtures are hand-written — add Stack comparisons.

**Every gate needs a mechanism-engaged assertion.** A pixel diff passes perfectly when the
blend is skipped entirely, because the output then equals the backdrop. Pair each visual
check with proof the path ran: assert pass count and bound-texture count equal the layer
count, and that the selected mode's helper appears in the emitted shader. Then perturb the
implementation and confirm the gate fails.

Exercise **all 22 modes**, both blend spaces, and every wiring combination — including the
partially-wired case, where `isTextureMode` is true but some Source ports are unwired and
must fall through to their defaults. Defaults prove least.

## 9. Commit sequence

| # | Commit | Notes |
|---|---|---|
| 1 | `fix(compiler): resolve dynamicInputs when finding texture boundaries` | §5.1. Ships with a gate that fails without it. No node uses it yet. |
| 2 | `test(verify): cover every texture port, not just the first` | §8. |
| 3 | `feat(compiler): dynamicParams, the per-instance counterpart to dynamicInputs` | §5.2. |
| 4 | `feat(nodes): blend-mode helper library` | 22 modes, both backends, verified standalone before any node consumes them. |
| 5 | `feat(nodes): stack compositing node` | Node + codegen + layer model. Verifiable via `window.__sombra.setParams`; **not yet human-usable** — the layer list has no generic UI. |
| 6 | Figma | Layer row, list header, all reorder states. Atomic, variable-bound. |
| 7 | Sandbox | `src/sandbox/` harness, real React on real tokens, interactions live. Sign-off here. |
| 8 | DS pipeline | `sombra.ds.json` entry → `npm run tokens` → wire `ds.*` → `tokens:audit`. |
| 9 | `feat(ui): stack layer list editor` | `portsRenderedByComponent` + component binding, one clean pass. |

Commits 1–3 are framework work with no visible feature; each is independently verifiable
and independently revertable. Splitting 5 from 9 means the blend maths is proven before it
is wired into a UI where errors are hard to localise.

## 10. Out of scope

- **Per-layer alpha operators** (replace / max / multiply …, as Fragment Output offers).
  They fight the alpha-aware `over` in §3: `a_o` is not a free parameter, and overriding it
  shifts visible colour as a side effect. Revisit only if `over` proves insufficient.
- **Texture masks.** Mask is a connectable float, evaluated in Stack's own pass. A texture
  mask would double the pass boundaries per layer.
- **Layer groups, clipping masks, adjustment layers.**
- **Reordering by dragging the wires** rather than the rows.

## 11. Open questions

- Whether hidden layers should keep their upstream pass alive (cheap to toggle) or drop it
  (cheaper to render). Leaning drop — `visible` is already a recompile param.
- Whether the blend-space switch belongs on the node or should follow the document.
