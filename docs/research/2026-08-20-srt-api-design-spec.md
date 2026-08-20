# SRT API design-spec

**Date:** 2026-08-20 · **Status:** DESIGN (for sign-off before build) · Supersedes the SRT half of `2026-08-19-srt-gizmo-epic.md`. Prereq #1 (coordinates → `fragCoord()` construct) is **done** (`e26c690`).

> **Naming (DECIDED 2026-08-20, supersedes 'screen'/'local' below):** the Offset
> Space values are **`'world'` / `'node'`** — matching the gizmo's World/node
> coordinate switch (one axis, one vocabulary). `world` = the fixed canvas frame
> (was `screen`); `node` = the node's own scaled+rotated frame (was `local`).
> Legacy stored values `'screen'`/`'local'` are normalized on read by
> `normalizeTranslateSpace` (`src/compiler/ir/srt.ts`) — the ONE place the alias
> mapping lives. Older mentions of screen/local in this doc read as world/node.

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

## Decision log — 2026-08-20 (post-build QA round)

**DECIDED — naming: `world` / `node`.** See the note at the top. Param labels
"World"/"Node", values `'world'`/`'node'`, default `world`, legacy
`'screen'`/`'local'` normalized on read. Gate: `verify-srt.ts` section E asserts
the alias mapping AND that legacy values emit byte-identically.

**DECIDED — the toggle is continuity-preserving (navigation, not reinterpretation).**
The user's core issue with the original toggle: it *reapplied* the stored offset
under the new frame, making content jump. The use case is **navigating to a point
by switching frames along the way** — so switching Offset Space must **convert**
the offset into the new frame, leaving the render identical at the switch:
`world→node: a' = R(θ)·a / s` · `node→world: a' = s·R(−θ)·a` (a = (tx, −ty)).
Prototyped and verified live in `/srt-renderer-sandbox.html` (rot 30°, offset
(120,0) → toggle → identical render, offset re-expressed to (104,−60)).

**DECIDED — gizmo axes are for precision input.** "Rides with the frame" as a
*storage* semantic is hostile to gizmos: users expect the node's rotation/scale
axes as a **precision input orientation**, not as a coupling that moves content
when Scale/Rotate later change.

**DECIDED — ONE STORAGE (option b): "one storage — the toggle is just a way to
interpret all coords."** The shader keeps ONE translate semantic (world);
`srt_translateX/Y` always store the world offset; Scale/Rotate never move an
existing offset; toggling never changes the render. `node` is a VIEW/edit
mode: the offset sliders (ShaderNode) — and later the gizmo axes — display and
edit the offset along the node's rotated+scaled frame, converting to world on
write (`worldOffsetToNode`/`nodeOffsetToWorld` in `ir/srt.ts`). The shader
`node` path is retired; `IRSpatialTransform` no longer carries `translateSpace`.

**Migration** (`src/utils/srt-migration.ts`, hooked beside `dedupeNodeIds`):
pre-one-storage saves convert offsets `t_world = S·R(−θ)·t_node` so they render
identically. The missing-key case is ambiguous for non-exposed spatial nodes,
so mode is caller-supplied: `.sombra` files / imports / share URLs = `'convert'`
(main-era, node semantics); localStorage persist = `'stamp-only'` (the working
graph already rendered under world semantics on this branch — keep what the
user has been seeing). Explicit `'local'` always converts (unambiguous), view
preserved as `node`. Gated end-to-end in `verify-srt` section F, including a
registry-drift check on the migrating-type list.

**Follow-up noted (not this change):** warp hand-rolls a second SRT copy onto
its internal noise coords (node-frame math, `warp.ts:84/162`) — now divergent
from its framework-injected coords. Fold into the reeded migration (step 5).
