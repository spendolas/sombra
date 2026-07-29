# Reeded Glass: the minification residual — closed

**Date:** 2026-07-29 · **Status:** CLOSED, not by sampling · **Node:** `src/nodes/transform/reeded-glass.ts`

The `|L'| ≈ 176` residual is **not a tap-count problem**. Raising the supersample cap
from 8 to 16 improves exactly one config of 26, by 0.27 codes, for +26% fetches.
`MINIF_MAX_TAPS` stays at 8. What remains at high curvature is real optics — a
multi-caustic profile — and the only lever left changes the look.

---

## The measurement was broken first

Every tap-count comparison before this was scored against the wrong reference, and it
took two wrong conclusions to notice.

Ground truth in `phase12 --stage=regress` was `('pre','A8')` — a 16×16 supersample of
the **pre-change** node. That node averages in **sRGB**; the shipped node has averaged
in **linear light** since `7f49343`. The two disagree by construction, so absolute
error against it is meaningless for the current node, and A/B comparisons between
shipped variants measure "which one resembles an sRGB-averaged reference".

`('shipped','A8')` is wrong the other way: supersampling a shader that already
self-filters converges on **its own blur**, not on the truth.

The valid reference is the shipped **colour pipeline** with the internal supersample
**off**, then 16×16'd. Added as `ShaderMode = 'no-minif'`, which rewrites the emitted
`} else if (rg_nt_<id> > 1.0) {` guard to `false` and throws if the guard is not found,
so a codegen change cannot silently produce a bogus reference. Surfaced as a `TRUE-GT`
column beside the legacy one.

The two references disagree a lot, which is the point:

| config | vs PRE-GT (invalid) | vs TRUE-GT (valid) |
|---|---|---|
| rot45 | 12.38 / 87 | **2.26 / 21** |
| misaligned | 8.56 / 66 | **3.07 / 24** |
| wave-sine | — | **2.69 / 21** |
| ior2p5 | 2.57 / 31 | **4.70 / 59** |
| curv1p5 | 4.85 / 70 | **5.20 / 73** |

## The cap does not matter

Cap 8 vs cap 16, all 26 configs, valid reference:

| config | cap 8 | cap 16 | fetches |
|---|---|---|---|
| curv1p5 | 5.20 / 73 | 4.93 / 66 | 2.22 → 2.79 (+26%) |
| the other 25 | — | **bit-identical** | unchanged |

0.27 codes mean and 7 codes max on one config, below perceptual threshold, for a 26%
fetch increase in the only regime that already pays. Cap 32 was worse than 16.

The 25 unchanged configs are not a null result — they are the expected one. The cap
only binds where `|L'| > 8`, which is:

| cfg | % of rib minifying | max \|L'\| | % needing >8 taps |
|---|---:|---:|---:|
| defaults 1.5 / 0.80 | 0.00% | 0.9 | **0%** |
| 1.5 / 0.85 | 5.60% | 1.9 | **0%** |
| 2.5 / 0.80 | 32.85% | 4.6 | **0%** |
| 1.5 / 1.00 | 21.38% | 175.3 | 6.58% |
| 1.5 / 1.50 | 29.77% | 263.5 | 9.06% |
| 1.65 / 2.15 | 52.86% | 491.8 | 14.71% |

**IOR alone never reaches the cap** — ior 2.5 tops out at `|L'|` 4.6. It takes
curvature above ~0.9, because `amp = curvature` multiplies into `A = (ior-1)·amp·k`.

## What the shipped state actually buys

Corrected against the valid reference. These are better than the figures quoted in
`2026-07-28-reeded-glass-edge-aa.md`, which used the PRE-GT:

| config | 1 tap | shipped | factor |
|---|---|---|---|
| stair-circular | 8.98 / 12 | 0.06 / 1 | **143.8×** |
| stair-noise | 7.80 / 9 | 0.20 / 1 | 39.0× |
| rot45 | 30.99 / 170 | 2.26 / 21 | 13.7× |
| wave-sine | 28.09 / 176 | 2.69 / 21 | 10.5× |
| rot15 | 27.05 / 159 | 2.65 / 19 | 10.2× |
| dpr-anim | 31.25 / 159 | 3.10 / 20 | 10.1× |
| misaligned | 24.07 / 127 | 3.07 / 24 | 7.8× |
| curv1p5 | 18.27 / 135 | 5.20 / 73 | 3.5× |
| ior2p5 | 11.57 / 77 | 4.70 / 59 | 2.5× |

Configs absent from this table are byte-identical to one tap, which is correct: no
seam straddles a pixel and nothing minifies.

## Rejected: a 2-D sample pattern

The prior AA study found 1-D supersampling **saturates** — "4 → 8 taps buys 0.11
codes", and "the residual lies in the axis the 1-D box never samples". The
minification supersample is 1-D along the seam normal, so that looked like the fix.

Tried a Vogel disc over the pixel with the offset projected onto the gradient for the
phase. **Worse on every config**, and it broke cross-backend parity from 1 to 116
codes, because the per-pixel rotation was seeded from `reedPcg(floor(base))` where
`base` is `gl_FragCoord` / `in.position` — **opposite y origins**. That hazard is
documented in a comment in the same file.

The prior finding does not transfer: it was measured on seam-coverage AA of a hard
step edge, a different problem from integrating a smooth but heavily compressed map.

## Why it is closed

`|L'| = 492` at the top of the curvature slider means one screen pixel covers 492
source pixels. No tap count reaches that. And it is not purely a sampling artifact:
the earlier ground-truth study found the ripples at curvature 1.5 **survive 256
samples**, because the profile genuinely produces up to 28 caustics per rib once the
slope is unbounded.

So the residual is the *profile*, not the filter. The remaining levers both change the
look and are therefore the user's call, not a defect fix:

- **Slope clamp** — bound `|L'|` by capping the profile slope rather than the shape.
  `min(c, 0.99)` bounds the shape parameter but leaves `(1-x²c₂²)^(-3/2)` free, which
  reaches ~10³ near the rib edge. Free, and it makes the top of the curvature slider
  usable, but it changes every graph above curvature ~0.9.
- **Mips for pass textures** — the classical answer, and an engine change: WebGPU has
  no `generateMipmap`, so it needs a manual blit chain, log₂(n) passes per intermediate
  per frame. Anisotropic filtering would help more than plain mips here.

## Repro

```bash
npx tsx scripts/blur-bakeoff/phase12-shipped-aa.ts --stage=regress   # TRUE-GT column
```

Change `MINIF_MAX_TAPS` in `src/nodes/transform/reeded-glass.ts` and re-run to
reproduce the cap sweep. Note the harness takes ~4 min per run; do not chain multiple
runs in one shell pipeline (it re-executes per substitution and times out).
