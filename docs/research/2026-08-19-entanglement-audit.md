# Cross-node "math doesn't follow the stream" — multi-hypothesis audit

**Date:** 2026-08-19 · **Branch:** `fix/node-id-collision` (audit only; no fixes yet) · **Trigger:** user report that some nodes affect other nodes' math non-sequentially, with reeded_glass **frost/grain** as the visible example.

Method: 8 parallel hypothesis investigators + 1 adversarial synthesizer over the compiler/renderer, plus first-hand verification (code reads + a live compile of the real "Blurred O" graph via `window.__sombra`).

## Root pattern

**A node's math is driven by shared compiler/renderer state that reaches it OUTSIDE its DAG input edges** — so influence flows across or against the stream. Two channels:

1. **Global uniforms sourced from the terminal Fragment Output node** (`u_anchor`) — one value uploaded to every pass; every upstream `auto_uv`/spatial node bakes it into its coordinate frame.
2. **"A pass is a DEPTH GROUP, not a node."** Unrelated equal-depth nodes share one render target and its per-pass built-ins (`u_resolution`/`u_dpr` scaled by `RenderPass.resolution`), plus cross-pass re-emission re-runs a node against the *consuming* pass's frame.

Frost/grain is where it shows first because grain is a per-cell hash (high frequency) and resolution-sensitive; the frost blur (low-frequency average) hides the same errors. This is a *different* bug class from the node-id collision fixed earlier on this branch.

## Verified findings (ranked)

Confidence and verification status are mine, not just the agents'.

### F1 — Live-drag fast path drops multi-pass sub-pass uniforms  ★ pure bug, verified by code
`expandMultiPassNodes` mints sub-pass ids (`blur-sp1`, …). Their uniforms are emitted with `nodeId = <sub-pass id>` (`ir-compiler.ts:243-252,404-411`). On a slider drag (uniform fast path, no recompile) `collectCurrentUniformValues` builds `nodeMap` from **authored store nodes only** (`use-live-compiler.ts:95`) and `if (!node) continue` (`:103`). Sub-pass ids aren't in the store → their uniforms are silently skipped → **sub-passes 1+ freeze at their last-compiled value while you drag.** A separable blur goes anisotropic mid-drag.
- Not triggered by Blurred O (its blur radius is *wired* → re-emitted, not a uniform).
- **Fix:** resolve `spec.nodeId` through `baseNodeId()` (exported by `expand-passes`) before the `nodeMap` lookup, or fan one authored value to all sub-pass uniform names.

### F2 — A pass's resolution can't be pinned to 1.0 by a regular sibling  ★ pure bug, verified by code
`resolvePassResolution` (`pass-resolution.ts`) takes MAX over only nodes that declare a scale: `if (!fn) continue` (`:34`) skips every node **without** `multiPass.resolution` — i.e. every regular node. The docstring (`:12-18`) claims "a pyramid whose sibling pins the pass to 1.0 … still renders correctly" — **the code does not implement that.** So a downscaling pyramid-blur sub-pass sharing a depth group with an edge-unrelated node forces the whole pass (and that node) to the reduced scale; the renderers scale `u_resolution`/`u_dpr` for the pass, changing the unrelated node's rendered math. **This is the grain-relevant cross-node channel** (grain pitch is resolution-driven).
- Constructible; not present in Blurred O (regular Gaussian blur declares no resolution).
- **Fix:** if a pass contains any node whose def has no `multiPass.resolution`, force resolution 1.0/undefined (an implicit full-res pin). Or resolve per-subtree, not per depth-group.

### F3 — Cross-pass re-emission recomputes value-drivers against the CONSUMING pass's built-ins  (compounds F2)
A non-texture value edge crossing a pass boundary is re-run inline in the consuming pass (`ir-compiler.ts:637-656`), transitively (`:581-611`), assembled with that pass's `standardUniforms`. A re-emitted node reading absolute px (not `auto_uv`/`screen_uv`) yields a **different value** in a scaled pass. Combined with F2, a frost driver (e.g. gradient2) could be re-evaluated at a resolution it never rendered at → `reeded_glass.frost` takes a value tied to the reeded pass's geometry, not the driver's stream value.
- Latent in Blurred O (all passes full-res).
- **Fix:** forbid re-emission across a resolution-scaled boundary (route via texture/uniform), or guarantee re-emitted drivers read only resolution-invariant coordinates; add a verify gate that a re-emitted node's output equals its native-pass output under a scaled pass.

### F4 — Global `u_anchor` from the downstream Fragment Output re-bases every upstream `auto_uv` (incl. frost grain seed)  — real but largely by-design
`u_anchor` is set once from `fragment_output.anchor` (`App.tsx:91`) and uploaded to every pass. `auto_uv` is anchor-relative; reeded builds its grain-seed coord from `auto_uv` (`reeded-glass.ts:876-877`, seed at `:513`). So changing the **downstream** Output anchor shifts the **upstream** frost grain field with no edge carrying it — the exact frost instance.
- **Live check (Blurred O):** flipping Output anchor center→top-left barely moved the field *at this canvas size* — `auto_uv`'s anchor term scales with `(canvas_size − REFERENCE_SIZE)`, so it only bites on **resize**. This is the documented anchor-reveal behavior, so it's designed coupling, not a logic error — but its phenomenology reads as "non-sequential."
- **Fix (if unwanted):** seed the grain off a raw frozen coordinate without the anchor term, or make anchor an explicit per-node input; otherwise document it.

### F5 — `isTextureMode` leaks a texture connection into a node's coordinate OUTPUTS  — low, partially mitigated
A node with a wired `textureInput` re-bases every `auto_uv`-defaulted vec2 input to `screen_uv` (`ir-compiler.ts:188-195`), which then flows into coordinate-valued outputs (e.g. `warp.warped`). Connecting/disconnecting `warp.source` can change `warp.warped`. In Blurred O the consumed output (`warp.warpedPhase`) recomputes an invariant auto_uv internally (`warp.ts:75-87`), so the concrete blur.radius coupling likely does **not** fire.
- **Fix:** compute coordinate outputs from frozen-ref auto_uv always; use screen_uv only for the texture-fetch coordinate.

### F6 — gradient computes framework SRT but discards it in default `stretch` drawMode  — within-node dead control
`ir-compiler.ts:301` always rebinds `inputs.coords = srt_<id>`, but gradient's default stretch mode builds its field from `v_uv` + p0/p1 control points (`gradient.ts:322-330`), ignoring the SRT var. So gradient **Scale/Rotate/Offset sliders do nothing in the default mode** (SRT preamble is dead code). Not cross-node, but a real "control does nothing" surprise. **Fix:** `showWhen drawMode==='pinned'` on the SRT params, or make stretch honor them.

### F7 — WGSL vec2 `sombra_mod` overload gated on a fragile whole-program regex  — WGSL-only silent-fail hazard
`wgsl-assembler.ts:326` appends the vec2 mod helper only if the concatenated program text matches `/sombra_mod(vec2f(/` or `/:\s*vec2f\s*=\s*sombra_mod/`. A vector `mod` written any other way misses the detector → helper omitted → Tint rejects the module → the `b56c19c` silent-fail class (reports SUCCESS then drops frames). Non-local textual coupling between nodes. Not exercised by Blurred O. **Fix:** emit the vec2/vec3/vec4 overloads whenever `sombra_mod(` appears, or pick the helper name deterministically at lowering time.

## What this means for the frost/grain report

- In **Blurred O specifically**, the top mechanical bugs (F1/F2/F3) don't fire (full-res passes, wired radius), and F4 is subtle at reference size. The grain look there is dominated by reeded_glass's **dual coordinate basis** — grain seeded in frozen-ref/isotropic/y-down space vs frost taps in screen/per-axis space, hand-reconciled across 38 `raw()` per-backend blocks (`reeded-glass.ts:146,154-156,900-901`). High-frequency grain exposes any mismatch there that the blur hides. This is a within-node spatial-correctness surface worth its own pass, and is the most likely driver of the *Blurred O* grain artifact.
- Across **other graphs**, F1/F2/F3 are the real cross-node "wrong-way" bugs (pyramid-blur pass-mates, dragging a multi-pass radius).

## Suggested fix order (QA-gated, on the branch)
1. **F1** and **F2** — clean, localized, each with an obvious fix + a mechanism-engaged verify gate. Highest value, lowest risk.
2. **F3** — needs a verify gate (re-emitted value == native under scaled pass); do with F2.
3. **F7** — deterministic overload emission; removes a silent WGSL footgun.
4. **F6** — UI `showWhen`, trivial.
5. **F4/F5 and the reeded dual-basis** — design calls / larger; discuss first.
