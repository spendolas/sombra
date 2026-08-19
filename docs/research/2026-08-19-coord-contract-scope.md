# Scope: GPU coordinate-contract differential (the real "mixed-up UV" catcher)

**Date:** 2026-08-19 · **Status:** v1 SHIPPED — `scripts/verify-coord-contract-gpu.ts` (`npm run verify:coord-contract:gpu`). Complements the Tier-1 static lint (`scripts/verify-coord-hygiene.ts`), which only flags danger zones. This is the behavioural catcher.

## v1 (shipped)
**Resize invariance**, both backends via system Chrome. For anchor=center, `auto_uv` depends only on offset-from-centre, so the centre NxN crop of a larger render must byte-match an NxN render. Verifies 6 auto_uv nodes (gradient-pinned, checkerboard, stripes, dots, noise, fbm) are invariant (0.00% diff), each with a misaligned-crop control so the metric can't be vacuous, plus a **real-node negative control** — gradient-*stretch* (fills the canvas from `v_uv`) is asserted resize-*variant* (33.4%), proving the check detects genuine `u_resolution`-scaling. GPU gate (needs Chrome), not in headless `verify:ci`.

## Remaining (not yet built)
DPR invariance, anchor re-basing, SRT-exact (needed for the SRT-order epic), static-determinism (phantom-animation — needs a `startTime` override since `render()` reads the wall clock), and the WebGL↔WebGPU Y-origin diff. Each needs a per-node contract + a mechanism-engaged perturbation. The v1 harness is the scaffold to extend.

---
_Original plan below._

## Why static isn't enough
Coordinate correctness is behavioural, not textual. The reeded grain bug was a *seed-vs-sample space mismatch* + a coverage/animation coupling — no regex sees that, and the Tier-1 lint flags 8 legitimate screen-space samplers as false positives. To actually catch it you have to *render the node and watch how its output responds to coordinate perturbations*.

## Approach
Reuse the existing real-GPU harness (`scripts/verify-pass-resolution-gpu.ts`, Chrome/WebGPU + readback). For each node, render its output, then perturb one coordinate variable at a time and assert the declared contract:

| perturbation | expected for auto_uv / frozen-ref content | expected for screen-locked content |
|---|---|---|
| **resize** (ref → 2×) | invariant — reveals more, does NOT scale/distort; pins to anchor | scales with resolution |
| **DPR flip** (1× → 2×) | invariant | invariant (device-px effects: consistent) |
| **anchor** (center → corner) | content re-bases per anchor, no distortion | n/a |
| **SRT** (spatial nodes) | output transforms exactly by the SRT | n/a |
| **static determinism** (frame t vs t+dt, no time input) | byte-identical (no phantom animation) | byte-identical |
| **seed/sample coherence** | a feature seeded from a coord must track that coord under the above (grain locked to its basis, not crawling) | — |

A mixed-up UV shows up as a violated cell: content that scales when it should stay put, a spatial node whose grain crawls independently of its SRT, or output that changes frame-to-frame with no time input (the grain twinkle class).

## What each node needs: a coordinate contract
Add a small declaration per node (a `coordContract` hint on NodeDefinition, or a side table in the script) naming which invariances apply — e.g. `{ resizeInvariant: true, dprInvariant: true, spatial: 'srt-exact', staticDeterministic: true }`. That declaration IS the spec the differential checks; writing it per node is the main authoring cost (and doubles as documentation of each node's intended coordinate behaviour).

## Catches (that Tier-1 can't)
- Grain/noise crawling or twinkling when nothing time-driven feeds it (the reeded overlay bug).
- A node using `u_resolution` where `u_ref_size` belongs → content scales on resize instead of revealing.
- Y-origin flips: content mirrored on one backend only (compare WebGPU vs WebGL2 readback).
- A texture sample and its seed diverging under resize/SRT.

## Effort / risk / limits
- **Effort: significant.** Extend the GPU harness with per-node perturbation passes + readback comparisons; author `coordContract` for the coordinate-touching nodes (the ~8 the Tier-1 lint flags are the priority set). Roughly a focused multi-session feature.
- **Needs Chrome/WebGPU** (like the existing `:gpu` gates) — not a pure-CI headless check, or run both backends for the Y-origin comparison.
- **Limits:** only checks declared contracts; a node with a wrong contract passes vacuously. Pair each contract with a perturbation that must fail if the contract is wrong (same mechanism-engaged rule as the other gates).

## Recommendation
Build incrementally: start with **static determinism** + **resize invariance** (the two that catch the most, including the grain-animation class) across the 8 coordinate-touching nodes, each with a mechanism-engaged perturbation. Expand to DPR/anchor/SRT and the WebGL↔WebGPU Y-origin diff after. Its own branch.
