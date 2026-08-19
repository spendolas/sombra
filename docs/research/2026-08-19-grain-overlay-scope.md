# Scope: reeded_glass grain rework (#2)

**Date:** 2026-08-19 · **Status:** SCOPE — not implemented; needs design sign-off · **Prereq:** #1 frost clamp shipped (`1b582c9`).

## Problem (confirmed against code)
Grain is a **per-cell rotation/seed of the frost gather's Vogel spiral**, and the gather **averages** its 16 taps (`emitFrostGather`, reeded-glass.ts:502–549). So grain lives *inside* the average:
- **Inverted:** larger frost → larger gather radius → the average washes the per-cell variation out → grain is strongest where frost is *weakest*.
- **Consumed, not layered:** grain is baked into the sample *positions* that get averaged, so it is smoothed by the very blur it should texture. It can never sit "on top."

#1 (frost clamp) stopped the total washout but does **not** fix either property — that is this task.

## Proposed design — post-gather grain overlay (Option A)
Add a high-frequency grain term to the **final** frosted color, *after* the gather:
- **Amplitude scales with frost** → grain increases with frost (fixes the inversion).
- **Applied on top of the averaged result** → grain reads as an overlay (fixes "getting blurred").
- **Seeded from the frozen-ref coordinate** (`rg_coords`/`rg_gc`, already computed) via `reedPcg` → resolution/DPR-stable, no sin artifacts, matching the existing grain-stability contract (reeded-glass.ts:510–514).
- **rgb only, premultiplied-aware** — never write computed values to alpha (memory: dont-invent-alpha); pass `color.a` through.
- **Not a texture sample** → immune to the accepted frost bilinear-filter cross-backend divergence (`2026-07-29-frost-backend-divergence.md`).

### Where
- `src/nodes/transform/reeded-glass.ts`, right after `emitFrostGather` assigns `outputs.color`, in **both** `glsl()` (~:1041) and `ir()` (~:1361).
- Implement as a **single-emitter** `emitGrainOverlay(lang)` (mirroring `emitFrostGather`'s `lang`/`w` pattern) so the two backends can't drift — keeps the hand-written `raw(glsl,wgsl)` budget at 0 (CLAUDE.md guardrail).

### Rejected alternatives
- **B — stochastic partial-averaging** (blend sharp vs gathered per cell): physically closer but noisy and doesn't cleanly scale with frost.
- **C — per-cell UV jitter of a final lookup:** reintroduces the averaging-consumes-grain problem.

## Design decisions needed before implementing (these change the work)
1. **Amplitude source.** Scale grain amount purely by `frost` (grain "follows" frost, per the report), or add a **separate "Grain Amount" param**? A new param triggers the System-Wide Change Checklist (DS `sombra.ds.json`, Figma variable, `BROWSER-AUTOMATION.md`, node-template docs). Recommend: **start frost-scaled with an internal strength constant**; add an amount knob later only if wanted.
2. **`grain` param meaning.** Today `grain` = scatter **cell size** (0–16). Repurpose it as the overlay's cell size, or keep scatter-rotation as-is and make `grain` control the overlay? Recommend: **`grain` = overlay cell size**; decouple the scatter rotation seed so the gather quality is independent.
3. **Appearance.** Monochrome luminance grain (film-like) vs per-channel; additive vs multiplicative. Recommend: **additive luminance, premult-aware.**
4. **Keep or drop the scatter-rotation "grain".** It's not really grain (it's gather jitter). Keep it for gather quality (rename its role internally) and let the new overlay own the visible "grain" control.

## Verification plan
- **Parity:** single-emitter → `verify:ir-poc` (85) + `verify:wgsl-multipass` (159) stay green (both backends identical).
- **Mechanism-engaged gate** (extend `verify-stream-fixes.ts`): compile at frost 0.2 vs 0.8 and assert the grain coefficient scales with frost (perturb: equal coefficients → fail); assert the grain term references the *averaged output var* (applied post-gather, not inside the loop).
- **GPU:** `verify:wgsl-multipass` compiles on real GPU.
- **Visual acceptance (your QA):** on Blurred O, grain increases toward the high-frost (bright) side and reads as a crisp overlay, not a wash.

## Risk / effort
- **Risk: moderate.** reeded_glass is the most complex node (38 `raw()`, documented cross-backend fragility). The overlay itself is localized and computed (no texture/coord/pass changes), which contains the risk. Main hazards: resolution invariance (seed from frozen-ref), alpha handling (rgb only), backend parity (single-emitter).
- **Effort: one focused session** — `emitGrainOverlay`, wire into both paths, the param decision from Q1–Q4, a mechanism-engaged gate, `verify:ci`, live QA.
