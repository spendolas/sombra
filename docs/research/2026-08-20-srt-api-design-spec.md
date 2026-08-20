# SRT API design-spec

**Date:** 2026-08-20 · **Status:** DESIGN (for sign-off before build) · Supersedes the SRT half of `2026-08-19-srt-gizmo-epic.md`. Prereq #1 (coordinates → `fragCoord()` construct) is **done** (`e26c690`).

## Goal
Make SRT a **single-source API**: one canonical definition that generates **three** consumers — GLSL lowering, WGSL lowering, and a **gizmo-facing query** — so a node (and a gizmo) gets identical, order-correct behaviour regardless of backend. Today the compose order is written 3× (`glsl-generator.ts:562-591`, `ir/glsl-backend.ts:197-228`, `ir/wgsl-backend.ts:552-585`) + reeded a 4th/5th; consistent only by hand, gated by nothing; reeded bypasses the framework entirely.

## The single source
Extend `SpatialConfig` (currently `{ transforms: TransformKind[] }`, `nodes/types.ts:94`) into a canonical **ordered op-list** the backends only supply *syntax* for:

```
SRT op-list (canonical order): [ subAnchor, scale, rotate, translate, addAnchor ]
```
- **`translateSpace: 'screen' | 'local'` — default `'screen'`.** `screen` (independent): translate is applied in the FINAL frame, so an Offset is a constant screen nudge regardless of scale/rotate. `local`: today's behaviour (translate inside the scaled+rotated frame). This is the exposed choice — order stays canonical; only *where translate lands* varies. (For `screen`, translate moves to after `addAnchor` / is applied in screen space; for `local`, it stays between rotate and addAnchor as now.)
- Each op reads its uniforms from the existing `getSpatialParams` set (`srt_scale/rotate/translateX/translateY`), unchanged.
- One lowering function per backend consumes the op-list; **neither hand-writes the order.** `IRSpatialTransform` (`ir-compiler.ts:281`) becomes the carrier of the op-list + `translateSpace`, not just loose uniforms.

## Effect-node SRT semantics (DECIDED 2026-08-20)
A node's SRT transforms **only that node's own content coordinate** — a generator's pattern, or an effect's own structure (reeded's ribs/lens). It does **NOT** re-sample upstream sources through the new frame: **source reads happen in the source's own frame.** To move a source, put SRT on the source node (the previous step). Strict Photoshop adjustment-layer reading, not Smart-Object-with-filter.

Consequences:
- A **pure** resample effect (blur of a fixed source, no own structure) → its SRT is a **no-op**. Correct: you move the source, not the blur. So SRT is a per-node opt-in (generators + own-structure nodes), which is why `SpatialConfig`/`spatial:` is where a node declares it *has* transformable own-content at all.
- **Architecture consequence:** the framework hands a spatial node **two** coordinates — `inputs.coords` (SRT'd, own-content frame, as today) **and a separate un-SRT'd source-sampling coordinate** (source/screen frame). Own content uses `coords`; **source texture reads use the un-SRT'd coord.** SRT is injected onto own-content coords only, never onto the source-sampling path.
- This is exactly the coords-vs-source-read split behind the reeded frost/grain bug — formalising it here means the reeded migration (step 5) reads its source in the source frame and uses SRT'd coords only for ribs/grain.

## Consumer 1+2: shader lowering
`lowerSpatialTransformToGLSL` / `...ToWGSL` iterate the op-list and emit only the per-op syntax (`vec2` vs `vec2f`, `uniforms.` prefix). Delete the legacy inline copy in `glsl-generator.ts:562-591` and route it through the same source. Result: changing the order — or fixing `translateSpace` — is a **one-place edit**.

## Consumer 3: the gizmo API — `resolveSRT()`
A pure function the gizmo layer calls per node to get **structured transform data** (never shader text):
```
resolveSRT(node) -> {
  translate: vec2, rotate: radians, scale: vec2, anchor: vec2,   // resolved param values
  translateSpace: 'screen' | 'local',
  // the transform expressed in BOTH frames so the gizmo's world/node switch works:
  world: Mat3 (or {origin, basisX, basisY}),   // screen/world frame
  node:  Mat3,                                   // node-local frame
  inverse: (screenPoint) -> paramDelta           // map a handle drag back to param values, space-aware
}
```
This is what lets a gizmo (a) place handles at the right screen position, (b) map a drag back to the correct `srt_*` param delta under either `translateSpace`.

### Gizmo requirements → API implications (your notes)
- **2D/3D (C4D/Blender-like, needs visual design):** `resolveSRT` returns *structured* transform data (translate/rotate/scale/anchor as values + frames), not baked pixels — so a 2D gizmo renders it today and a 3D one later without changing the SRT source. Keep the return shape dimension-extensible (2D now; don't preclude a z/3rd axis).
- **World / node coords switch (preview window):** the SAME axis as `translateSpace`, but as a VIEW/edit mode — hence `resolveSRT` exposes the transform in **both `world` and `node` frames**. The switch picks which frame the gizmo edits in.
- **Multi-node gizmo editing:** `resolveSRT` is per-node + pure; the gizmo layer queries N nodes and composes/edits the selection. API stays per-node; multi-selection is a gizmo-layer concern built on it.
- **On/off toggle in preview:** a preview-settings flag (`settingsStore`); when on, the gizmo layer calls `resolveSRT` for the selected/all spatial nodes. Not part of the SRT source.

## Migration order
1. ✅ Coordinates → `fragCoord()` construct (done — SRT re-bases these).
2. Op-list + `translateSpace` in `SpatialConfig`/`IRSpatialTransform`; one lowering per backend; delete the legacy inline SRT copy.
3. `resolveSRT()` pure function (shared by gizmo layer + tests).
4. Expose `translateSpace` as a param (see decision below); default `screen`.
5. Migrate **reeded-glass** onto `spatial:` — retire its hand-rolled SRT (GLSL 925-939, IR raw 1224-1249) + its hand-written `auto_uv`.
6. Gizmo layer consumes `resolveSRT` (the gizmo-upgrade epic proper: 2D/3D, toggle, multi-node, world/node switch).

## Verification (mechanism-engaged, per repo discipline)
- **Order-parity gate:** compile a real spatial node on both backends, assert the preamble encodes `scale→rotate→translate` identically; perturb one backend's order and confirm the gate FAILS.
- **`translateSpace` gate:** assert `screen` output is invariant to scale (an Offset moves the same screen distance at scale 1 and 3); `local` is not — a real differential, not a rubber stamp.
- **coord-contract `:gpu` SRT-exact:** extend the v1 harness — apply an SRT and assert the output transforms exactly by it (both backends).
- **`resolveSRT` unit tests:** a screen-space drag maps to the correct `srt_*` delta under each `translateSpace`, and world↔node frames round-trip.

## Decisions needed before build
1. **Param ownership of `translateSpace`** — end-user param (Screen/Local dropdown on spatial nodes, default Screen) / author choice in `SpatialConfig` / author-opts-in-to-expose. *Recommend: `SpatialConfig` opts in (`exposeTranslateSpace: true`), end users then get the dropdown defaulting to Screen — so simple nodes stay clean, nodes that want it surface it.*
2. **`resolveSRT` return shape** — needs to match what the gizmo renderer will consume; the Mat3-vs-decomposed choice depends on the gizmo design. Firm this when the gizmo layer starts.
3. **3D scope** — design the shape 3D-ready but build 2D only now? *Recommend yes.*
4. **`translateSpace` granularity** — one per node, or per-transform? *Recommend per-node (one toggle) for now.*
