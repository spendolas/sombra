# Radius-Adaptive Pyramid Gaussian Blur — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans, task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Replace the linear-sampled separable Gaussian in `src/nodes/effect/blur.ts` with the radius-adaptive pyramid Gaussian the bake-off chose — 71× less sampling work at σ64, shape indistinguishable from a full-resolution Gaussian.

**Design source:** `docs/research/2026-07-27-blur-algorithm-bakeoff.md`. The design is settled; this plan implements it. Do not re-litigate the algorithm choice.

**Architecture:** A `multiPass` node that expands into `2N+2` passes — N progressive halvings (5-tap dual-filter box), two coarse linear-sampled Gaussian passes (separable H, V), N progressive upsamples (8-tap dual-filter) — with each pass declaring its `RenderPass.resolution` (`0.5^depth`) via the `multiPass.resolution` producer built in the RenderPass.resolution work. The whole chain runs inside a linear-light, premultiplied-alpha bracket with one LSB of dither on the final write.

**Tech Stack:** TypeScript strict, dual codegen (`glsl()` + `ir()`), WebGPU (WGSL) + WebGL2 (GLSL ES 3.0). Verification = `scripts/*.ts` via `npx tsx`, with the existing blur bake-off harness (`scripts/blur-bakeoff/lib/`) as the shape oracle.

## Global Constraints

- **The pyramid depth `N = clamp(floor(log2(sigma / 4)), 0, 5)`**, `sigma = radius * (1/3)`. This keeps the coarse-level sigma near 4px at every radius — the single rule that makes it clean at both ends.
- **Coarse sigma by intrinsic subtraction, not division:** `sigma_coarse = sqrt(max(0, sigma_target² − intrinsic²(N))) / 2^N`, where `intrinsic(N)` for N=0..5 is `[0.31, 2.07, 4.68, 9.70, 19.21, 38.99]` (measured, from the bake-off). The down/up chain is itself a blur; ignoring it runs 3–4.5% wide and steps the width at each N boundary.
- **Radius becomes `updateMode: 'recompile'`.** `multiPass.count(params)` is evaluated at compile time, and N drives the pass count and per-pass resolution — both structural. The bake-off accepts "a dragged slider recompiles." This is a UX change from the current `'uniform'` radius; the debounced recompile path handles it.
- **Halve progressively, never in one jump.** Each downsample is a 5-tap dual-filter box (aliasing control); each upsample is an 8-tap dual-filter. The coarse blur is a REAL linear-sampled Gaussian — the dual filter's own kernels are not Gaussian enough (pure dual filter was flawed at σ32+).
- **Linear-light + premultiplied + dither**, reusing `src/nodes/shared/color-space.ts` (`sombra_toLin`, `sombra_toSrgb`, `sombra_dither`). Ingest sRGB-straight → linear-premultiplied once; egress linear-premultiplied → sRGB-straight + dither once. NOT per pass — decode/encode per pass would compound quantisation.
- **Both backends, always.** Every change lands in `glsl()` and `ir()` together. No new two-arg `raw()` — `verify:raw-budget` ceiling is 0. Emit through structured IR or a single `emit({...backend})` emitter (single-emitter split is allowed).
- **Depth fits both backends at radius ≤ 128.** Max N=3 → 7 intermediates (2N+1, coarse=2 passes) ≤ WebGL2 cap of 8, one to spare. Weak GPUs (cap 4) overflow at N>=2: degrade gracefully (the renderer already caps + warns), and clamp N so the coarse level is never skipped. Do NOT raise RADIUS_MAX past 128 without also doing bake-off engine change #2 (WebGL2 ping-pong reuse).
- **`auto_uv`/pinning invariance holds** because `RenderPass.resolution` scales `u_dpr` — already verified (168/168 GPU). The blur samples in screen-UV (`gl_FragCoord/u_viewport`), which is scale-invariant per the pass-resolution contract.
- TypeScript strict; `npx tsc -b` and `npm run lint` clean before every commit.

---

### Task 1: Pass structure — count, resolution, and per-subpass role, verified before any shader math

The riskiest structural assumption is that a `multiPass` node can expand into `2N+2` passes of three different kinds (coarse is two separable passes) at three resolutions, driven by a recompile radius. Prove that first, with a placeholder body, so the shader math builds on a verified skeleton.

**Files:**
- Modify: `src/nodes/effect/blur.ts` — `multiPass`, `radius` param, a `pyramidPlan(params)` helper
- Create: `scripts/verify-pyramid-structure.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pyramidPlan(radiusPx: number): { N: number; passes: Array<{ role: 'down'|'coarse'|'up'; depth: number; scale: number }> }` — the single source of truth for count, resolution, and role, used by `multiPass.count`, `multiPass.resolution`, and `ir()`/`glsl()` role dispatch.

- [ ] **Step 1: Write the failing test.** `scripts/verify-pyramid-structure.ts` asserts, using `test`/`assert` from `scripts/blur-bakeoff/lib/test-util.ts`:
  - `pyramidPlan` at radius {4,12,24,48,96,128} yields N {0,0,1,2,3,3} and pass counts {1,1,4,6,8,8} (2N+2, coarse=2 separable passes).
  - Pass resolutions are `1, 0.5, 0.25, …` down to `0.5^N` at the coarse level, then symmetric back up: e.g. N=2 → scales `[1, 0.5, 0.25, 0.5, 1]` across roles `[down, down, coarse, up, up]`. (Depth d pass has scale `0.5^d`.)
  - The final pass has scale 1 (draws to canvas), and the coarse pass has the smallest scale.
  - Compiling a `blur` graph (via `compileGraphIR`, as `verify-pass-resolution.ts` does) at radius 96 yields a `RenderPlan` with 7 passes whose `resolution` fields match the plan — this exercises the real `multiPass.count`/`multiPass.resolution` path end to end, not just the helper.
- [ ] **Step 2:** Run it, confirm it fails (`pyramidPlan` undefined).
- [ ] **Step 3: Implement `pyramidPlan`** and rewire `multiPass`:
  ```ts
  const INTRINSIC_SIGMA = [0.31, 2.07, 4.68, 9.70, 19.21, 38.99]
  function pyramidPlan(radiusPx: number) {
    const sigma = Math.max(0, radiusPx) * SIGMA_PER_RADIUS
    const N = sigma <= 4 ? 0 : Math.max(0, Math.min(5, Math.floor(Math.log2(sigma / 4))))
    const passes: Array<{ role: 'down'|'coarse'|'up'; depth: number; scale: number }> = []
    for (let d = 0; d < N; d++) passes.push({ role: 'down', depth: d + 1, scale: 2 ** -(d + 1) })
    passes.push({ role: 'coarse', depth: N, scale: 2 ** -N })  // H
    passes.push({ role: 'coarse', depth: N, scale: 2 ** -N })  // V — coarse is separable, two passes
    for (let d = N - 1; d >= 0; d--) passes.push({ role: 'up', depth: d, scale: 2 ** -d })
    return { N, passes }
  }
  ```
  `multiPass: { count: (p) => pyramidPlan(radiusOf(p)).passes.length, from: 'color', to: 'source', resolution: (i, p) => pyramidPlan(radiusOf(p)).passes[i].scale }`. `radiusOf(p)` reads `params.radius` (now recompile), clamped to `[0, RADIUS_MAX]`. Change the `radius` param `updateMode` to `'recompile'` and drop the `warnAbove`-only rationale comment (keep `warnAbove`).
- [ ] **Step 4:** `glsl()`/`ir()` for this task emit a PLACEHOLDER that passes the source through unchanged per sub-pass (read `__subPass`, sample source, write it), so the graph compiles and the structure is verifiable before the kernels exist. This placeholder is replaced in Tasks 2–5.
- [ ] **Step 5:** Run: structure test passes; `npm run self-validate` still 0 FAIL / 0 WARN (the pass-through blur changes emitted shaders, so the count MAY move — record the new count and confirm both backends compile). `validate-wgsl-multipass` green.
- [ ] **Step 6:** Register `verify:pyramid-structure` in package.json; `tsc`/`lint`; commit.

### Task 2: Downsample kernel — the 5-tap dual-filter box, verified against the bake-off's intrinsic σ

**Files:** `src/nodes/effect/blur.ts`; `scripts/verify-pyramid-blur-gpu.ts` (new).

- [ ] Implement the 5-tap dual-filter downsample for `role: 'down'` passes: sample the source at the four diagonal half-texel offsets plus centre, dual-filter weights, in linear-premultiplied space. Offsets are in the SOURCE pass's texel size (the previous, larger pass) — `1/u_viewport` at the source resolution, which the pass-resolution contract makes `1/(scale_prev · canvas)`.
- [ ] GPU gate (`verify-pyramid-blur-gpu.ts`, model on `verify-pass-resolution-gpu.ts` + `gpu-rig.ts` which already has `PassSpec.scale`): render N halvings of a known impulse and measure the intrinsic σ of the down chain; assert it matches `INTRINSIC_SIGMA[N]` within tolerance. This is the mechanism-engaged assertion — a downsample that silently no-ops would show σ 0, not the expected value.
- [ ] Prove the gate fails: perturb an offset, confirm σ diverges. Commit.

### Task 3: Coarse Gaussian — linear-sampled, with intrinsic-σ subtraction

**Files:** `src/nodes/effect/blur.ts`.

- [ ] For `role: 'coarse'`, emit the existing linear-sampled separable Gaussian (reuse the current `emit()` kernel — it is measured-clean) but at `sigma_coarse = sqrt(max(0, sigma² − intrinsic²(N))) / 2^N`, expressed in the coarse pass's texels. Because coarse runs at `0.5^N` resolution, one texel is `2^N` canvas px, so the sigma-in-texels is `sigma_coarse` directly.
- [ ] Note: the coarse Gaussian is 2D-separable, which itself needs H+V — but the bake-off's structure folds the coarse blur into ONE pass with a small sigma (~4px) 2D gather, OR two coarse passes. Decide from the bake-off's pass table (it lists "2× linear-sampled Gaussian at the coarse level"): the coarse level is TWO passes (H, V), both at `0.5^N`. Update `pyramidPlan` to emit two coarse passes and re-verify Task 1's structure test (counts become `2N+2`). **Resolve this against the bake-off pass diagram before implementing — it changes the pass count.**
- [ ] GPU gate: coarse-only (N chosen so down/up are identity) matches a reference Gaussian of `sigma_coarse` within the bake-off's shape tolerance. Commit.

### Task 4: Upsample kernel — the 8-tap dual-filter

**Files:** `src/nodes/effect/blur.ts`.

- [ ] Implement the 8-tap dual-filter upsample for `role: 'up'` passes, sampling the smaller previous pass at its texel size. Bilinear reads at the up-resolution reconstruct between coarse texels.
- [ ] GPU gate: full down→coarse→up chain at σ32 matches a full-resolution Gaussian of σ32 within the bake-off's mean-error tolerance (0.52 codes was the measured pyramid error). Perturb an upsample weight, confirm the gate fails. Commit.

### Task 5: The bracket — linear-light, premultiplied, dither

**Files:** `src/nodes/effect/blur.ts`.

- [ ] Ingest (first pass): decode sRGB→linear and premultiply once, reading the source. All intermediate passes operate on linear-premultiplied `rgba8`. Egress (final up pass, scale 1): un-premultiply, encode linear→sRGB, add `(sombra_dither(fragCoord) - 0.5)/255` on the write. Reuse `color-space.ts` helpers.
- [ ] Honor the "don't invent alpha" rule: alpha is carried through the premultiplied math, never computed onto a mask.
- [ ] GPU gate: a black/white edge blurred by the pyramid has its midpoint at sRGB ~190 (linear-correct), not ~132 (gamma-wrong); a soft-alpha sprite shows no colour halo in transparent regions. Both are mechanism-engaged (they fail if the bracket is skipped). Commit.

### Task 6: Verify against the bake-off's full corpus, both backends, and temporal stability

**Files:** `scripts/verify-pyramid-blur-gpu.ts`.

- [ ] Run the pyramid across σ {4, 12, 32, 64-clamped-to-128} on both backends; assert mean shape error against a matched full-resolution Gaussian is within the bake-off's figures (0.08 / 0.34 / 0.52 at σ4/12/32). A run that SKIPs a backend is a failure.
- [ ] Temporal: sweep radius continuously across an N boundary (e.g. σ 7.9 → 8.1, N 0→1) and assert the blur width does not step by more than the intrinsic-subtraction residual — this is what the `sqrt(σ²−intrinsic²)` correction buys. If it steps, the intrinsic table or the subtraction is wrong.
- [ ] Commit.

### Task 7: Docs, cost note, and the WebGL2 ceiling

**Files:** `src/nodes/effect/blur.ts` header; `NODE_AUTHORING_GUIDE.md`; `docs/research/2026-07-27-blur-algorithm-bakeoff.md` (status: implemented); `CLAUDE.md` blur mention.

- [ ] Update the blur node's header comment to describe the pyramid (it currently describes the separable Gaussian). State the radius→recompile change and why.
- [ ] Document the RADIUS_MAX=128 ↔ N≤3 ↔ 6-intermediate ↔ WebGL2-cap-8 chain, and that raising RADIUS_MAX needs bake-off engine change #2 first. Note the weak-GPU (cap 4) degrade.
- [ ] Mark the bake-off's recommendation as shipped; keep the "gaps" (directional/radial/bokeh not built) accurate.
- [ ] Full suite: `tsc`, `lint`, `build`, `raw-budget` (ceiling still 0 — no new hand-written two-arg), `self-validate` 0 FAIL / 0 WARN, `validate-wgsl-multipass`, the new pyramid gates, and a live browser render of a wide-radius blur with zero console errors. Commit.

---

## Self-Review

**Spec coverage:** N-rule → Task 1. Downsample → 2. Coarse + intrinsic-σ → 3. Upsample → 4. Bracket → 5. Corpus + temporal → 6. Docs + ceiling → 7.

**Coarse-pass fork — RESOLVED against the bake-off.** The pipeline diagram's "2× linear-sampled Gaussian at the coarse level" means TWO separable passes (H, V), both at `0.5^N`. So the pass count is **`2N+2`**, intermediates **`2N+1`**. Depth-fits-WebGL2 re-run: at N=3 that is **7 intermediates ≤ the cap of 8** — fits, with one to spare. `pyramidPlan` (Task 1) must therefore emit two coarse passes, not one; the structure test's expected counts become `2N+2` = {1,1,4,6,8,8} for radii {4,12,24,48,96,128}. (Weak-GPU cap-4 path still overflows at N≥2 — documented degrade, Task 7.)

**Kernel ground truth — located, not from memory.** The exact 5-tap down / 8-tap up dual-filter offsets and weights, and the intrinsic-σ compensation, are the measured winner in `scripts/blur-bakeoff/phase3b-winner.ts` and `scripts/blur-bakeoff/phase5b-fix.ts`. Read both before Tasks 2–4; they are the ground truth the bake-off's numbers came from. Do not reconstruct the kernels from the prose.
