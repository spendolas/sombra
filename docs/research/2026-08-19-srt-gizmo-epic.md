# PARKED epic: SRT + gizmo transform rework

**Date:** 2026-08-19 · **Status:** PARKED — not started. Deliberately deferred; do NOT open piecemeal (the three threads are coupled). Build the Tier-2 coord-contract GPU test FIRST (it's the safety net that makes an SRT-order change safe).

## Why parked
These three meet in the same coordinate/SRT/gizmo subsystem, and touching one forces the others:

1. **SRT functional + gizmo-reflected across ALL gradient modes** (feature).
   - Today: `pinned` applies SRT (reads the SRT'd `inputs.coords`, gradient.ts:283); `stretch` ignores it (builds from `v_uv` + `p0u/p1u`, gradient.ts:227). SRT sliders are always shown → dead controls in stretch.
   - Want: SRT works in every mode AND the gizmos reflect it. Motivating case: a uniform "little shift" (Offset) is awkward with the two-handle system.
   - Coordinate-space catch: framework SRT is frozen-ref px / y-down; stretch is `v_uv` screen / y-up. Translate is a clean px→UV divide; **rotate/scale need aspect + y-flip reconciliation** (the reeded-class hazard).
   - Interim: gradient SRT is **hidden** (not removed) — `getSpatialParams(...).map(hidden)` in gradient.ts; `spatial` config kept. Revive by dropping the `.map(hidden)`.

2. **SRT operation order possibly wrong — FRAMEWORK-WIDE.** Suspected wrong compose order of scale/rotate/translate in the SRT preamble (glsl-generator SRT temps + ir-compiler `IRSpatialTransform` lowering, `lowerSpatialTransformToWGSL`). Blast radius = every spatial node (uv-coords, image, noise, fbm, stripes, gradient, checkerboard, dots, warp). **Not yet diagnosed** — a read-only check of the current order vs intended (T·R·S vs S·R·T…) is the first step; it decides urgency.

3. **Gizmo upgrade notes** — (placeholder — paste notes here). They change how SRT is authored/visualized, so they can't be designed independently of (1) and (2).

## Prerequisite before implementing any of the above
**Tier-2 GPU coordinate-contract differential** (docs/research/2026-08-19-coord-contract-scope.md). Reordering SRT without it risks silent regressions across 9 spatial nodes; the contract test (SRT-exact + resize/DPR/anchor invariance + static determinism) is what catches a wrong compose order as a failed invariance.

## Revive checklist (when the epic runs)
- [ ] Build Tier-2 coord-contract GPU test.
- [ ] Diagnose + fix SRT compose order (framework-wide), guarded by the contract test.
- [ ] Make gradient SRT functional in all modes; unhide (drop `.map(hidden)`).
- [ ] Reflect SRT on gizmos; fold in the gizmo upgrade notes.
