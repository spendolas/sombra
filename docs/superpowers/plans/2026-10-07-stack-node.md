# Stack Node — Implementation Plan (Phase C + D4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the Stack compositing node: N layers, 24 blend modes, opacity and mask per
layer, composited as a chain of passes, with the layer list UI already signed off.

**Spec:** `docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md` (corrected
2026-10-07 — read §3, §4, §6.5–6.8, §8, §10 before anything).
**UI:** `src/components/StackLayerList.tsx` (merged, signed off in the sandbox at
`sandbox.html?c=stack-layer-list`). **Do not restyle it.** Every visual decision is in Figma
(Components page, Molecules row 7 · Stack; boards beside it) and was signed off by Nikita.

## Read this first: what this plan is and isn't

- **The code here is intent, not literal.** Plan code has been wrong three times on one
  plan. Where a signature in this plan differs from the source, the source wins — fix it and
  say so in the commit.
- **Do not push.** `main` deploys to sombra.sh on push. Work on a branch, report, stop.
- **Every gate needs a mechanism-engaged assertion and must be seen to fail.** A pixel diff
  passes perfectly when the blend is skipped, because the output then equals the backdrop.
  Assert pass count, bound-texture count, and that the selected mode's helper is in the
  emitted shader — then perturb and watch it go red. Perturb each site separately.
- **Both backends, always.** GLSL path and IR→WGSL path, in parity. WebGPU first, then GLSL.
  Zero hand-written two-arg `raw(glsl, wgsl)` — the library budget is 0 and stays 0.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Milestones and order

Each milestone is independently verifiable. Report at the end of each one; do not start the
next until the report is in.

### M0 — Blockers (framework, not Stack)

- [ ] **M0.1 · WebGPU unread texture binding (audit P0.2).** A texture port that is wired but
  not read leaves bind group 1 unset; `updateRenderPlan` returns success and the draw raises
  `"No bind group set at group index 1."`, invalidating the frame. **Hiding any wired Stack
  layer reaches this** (hidden layers are dropped from codegen). Fix it at the source, in the
  WGSL assembler / renderer binding path — the resource set declared must equal the resource
  set read, as relay pruning already enforces for GLSL. Gate 8 of
  `scripts/verify-renderer-caps-gpu.ts` pins the broken behaviour and **will go red when this
  is fixed** — flip it to assert no uncaptured errors, as its own failure message instructs.
- [ ] **M0.2 · `layout.ts` handle order.** `getInputHandleOrder` and the size estimator
  (`src/utils/layout.ts:37-38, 110-115`) read static `def.params`; a connectable dynamic param
  gets no handle position. Route both through `resolveParams` (`src/nodes/resolve-dynamic.ts`).
  Gate with a fixture whose connectable param exists only through `dynamicParams`, asserting
  the fixture is still in that regime by asking the definition directly (not through the
  function under test — see `scripts/verify-connection-validity.ts` for why).

### M1 — Blend-mode helper library (spec C1)

- [ ] 24 modes (§5): 20 separable + Hue, Saturation, Colour, Luminosity (PDF `SetLum` /
  `SetSat` / `ClipColor`). One file in `src/nodes/shared/`, IR helpers registered via
  `ctx.addFunction` (idempotent), emitted only for modes a graph actually uses.
- [ ] Each helper owns its degenerate guards (Colour Dodge / Burn / Divide denominators).
- [ ] Blend space: sRGB default, linear via the existing `sombra_toLin` / `sombra_toSrgb`
  (`src/nodes/shared/color-space.ts`).
- [ ] **Gate:** every mode on both backends, compared against a CPU reference implementation of
  the same formula at a spread of colour pairs including 0, 1 and the guard edges. Assert the
  helper text is present for the mode under test and absent for one not used.

### M2 — The node (spec C2)

- [ ] `src/nodes/<category>/stack.ts`, registered in `ALL_NODES`. One output, `color`.
- [ ] **Data model (§8, corrected):** a hidden `recompile` param holding `layers:
  StackLayer[]` (`id`, `name`, `blendMode`, `visible`) plus hidden `nextLayerNumber`.
  **Default: two layers**, "Layer 1" and "Layer 2", `nextLayerNumber: 3`. Names are assigned
  at creation and never derived from position.
- [ ] Ports from the array: `dynamicInputs` → `layer_<id>` (`color`, `textureInput: true`,
  **explicit default `[0,0,0,0]`** or an unwired port is a hard compile error);
  `dynamicParams` → `opacity_<id>` (connectable float, uniform) and `mask_<id>` (connectable).
- [ ] **Chain (§4):** `multiPass` with `count` = visible layer count, `requiresWiredSource:
  false`, and `routeEdge` routing layer k's source, opacity and mask to sub-pass k only.
  **`routeEdge` must return `true` for handles it does not recognise** (§4: a whitelist
  silently discards global params). Count 0 → emit an explicit transparent constant.
  Count 1 → the degenerate chain must still route (§4, fixed 2026-09-14 — keep it fixed).
- [ ] **Maths (§3):** straight alpha; `c_s' = (1-a_b)·c_s + a_b·B(c_b,c_s)`; alpha-aware over;
  guarded divide. Clamp layer colour, opacity and mask to [0,1] on entry. Stack legitimately
  computes alpha — state that in the file header so a reviewer doesn't read it as a breach of
  the "don't invent alpha" rule.
- [ ] Hidden layers are dropped from codegen (`visible` is recompile). With M0.1 fixed this is
  safe; **prove it** with a gate: wire three layers, hide the middle one, assert WebGPU renders
  with zero uncaptured errors and the hidden layer's colour is absent from the output.
- [ ] **Defaults deep-cloned** — `FlowCanvas.tsx:66` `defaultParamsFor` is shallow, which
  would alias the registry's default layer array into every Stack and drop the layer list from
  share URLs (§6.7). Fix it generally, not just for Stack.
- [ ] Verifiable through `window.__sombra.setParams` before any UI.

### M3 — Convergence gate (spec C3)

- [ ] The gate §10 calls highest-value: convergence, relays, the `anyFullRes` pin. Stack of 2,
  4, 8 layers; one layer fed by a multi-pass blur; one source feeding two layers; a Stack
  nested in a Stack. Assert pass counts and slot counts on **compiler-produced** plans.
- [ ] Extend the registry-driven gates that won't see Stack on their own (§10):
  `verify-wired-texture-branch.ts` (first texture port only), `validate-wgsl-multipass.ts`
  (hardcoded `TEXTURE_NODES`), `verify-ir-poc.ts` (hand-written fixtures).

### M4 — Wire the UI (spec D4)

- [ ] **`portsRenderedByComponent`** — a general `NodeDefinition` flag (none exists today) so
  `ShaderNode` skips its generic handle rendering (`ShaderNode.tsx` ~385-408) and its
  `inputCount` `+`/`−` row (~122-130, 411-433) for nodes that draw their own. Handle ids must
  equal port ids or edges drop on reload.
- [ ] Render `StackLayerList` in the Stack body, passing `BaseHandle` through `renderHandle`
  (port ids `layer_<id>` / `opacity_<id>` / `mask_<id>`). Source labels from the same
  source-lookup `ShaderNode` already does for connected params.
- [ ] **One atomic store action** for every layer mutation (add, remove, reorder, visibility,
  blend): writes params **and** strips or keeps edges in a single `set` with one history entry,
  modelled on `removeElements` (`graphStore.ts:258`). Today `onEdgesChange` (`:199`) pushes
  history without clearing `_lastActionKey`, so remove-port + its wires is two undo steps.
  **Never mutate `layers` in place** — undo snapshots are shallow.
- [ ] **`updateNodeInternals`** after reorder — it is called nowhere in the repo, and reorder
  moves handles without changing node size, so a size-based re-measure won't catch it. Without
  it wires stay drawn at the old positions.
- [ ] Gate: add / remove / reorder / hide each leave edges correct, and **one undo** restores
  the previous state including wires.

### M5 — System-wide checklist (CLAUDE.md)

- [ ] `BROWSER-AUTOMATION.md` node tables; node count 45 → 46 in `CLAUDE.md`, `AGENTS.md`,
  `ROADMAP.md`; a test preset in `src/utils/test-graph.ts`.
- [ ] Figma node template + `.figma/wiki/templates/node-templates.md` — **ask before touching
  Figma**; the Stack boards already exist on the Components page.

## Known, not in this plan

- **Consumer-ordered pass emission** (`2026-09-14-consumer-ordered-emission.md`) — not built.
  Without it the WebGL2 fallback holds a Stack to about 7 layers. Over the cap is now a
  visible, readable error (Phase A), not a wrong image, so Stack can ship first. Separate
  track.
- **WebGL2: blur feeding pixelate renders blank** — pre-existing, reproduces on `main`, not
  Stack's. But Stack will composite blurred layers routinely: include a blurred layer in the M3
  fixtures and report what WebGL2 does. Do not fix it inside this plan.

## Report format, per milestone

What changed in one sentence; every gate with its pass count; each perturbation and the
assertion that went red; anything in this plan that turned out wrong. Then stop.
