# Engine API-coverage map

**Date:** 2026-08-19 · **Method:** 10-concern parallel audit + adversarial synthesis. Classifies each engine concern a node touches as a **first-class IR construct** (single source, both backends generated) vs **hand-lowered twice** (separate GLSL + WGSL, can diverge) vs **bypassable** (nodes reach around it via `raw()`).

## Headline
The IR-as-API vision is **real and advancing** — control flow (`if`/`for`/ternary), the Y-origin difference (`fragCoord`/`framebufferY`), texture sampling + explicit LOD, and `mod`/`atan` disambiguation are genuine first-class constructs with single IR sources, both backends generated, and **mechanism-engaged GPU parity gates**. Hand-written two-arg `raw()` **in node bodies is at 0** and ratcheted. Strong, verifiable core.

**But "single source" stops at the node-body boundary.** The foundational concerns a node *cannot avoid* are still hand-lowered twice **one layer up** — in the compiler core + renderers, which `verify-raw-budget` doesn't even scan (it globs `src/nodes` only). That is where the next silent WebGPU↔WebGL2 divergence will come from — not from node bodies.

## Map (all "mixed" — clean construct exists but not yet the single source)
| Concern | Trip risk | The gap |
|---|---|---|
| coordinates-uv | **HIGH** | `auto_uv`/`auto_fragcoord`/`screen_uv` are 3 hand-written two-arg `raw()` in `ir-compiler.ts` (arms already differ); pixel-grid/pixelate bypass via `variable('gl_FragCoord.xy')`. `fragCoord()`/`framebufferY()` construct exists but isn't the source for the core defaults. |
| srt-spatial | **HIGH** | Compose order written 3× (+ reeded 4th/5th); agrees today only by hand-verification, no gate. reeded bypasses framework injection entirely. |
| multipass-resolution-memory | **HIGH** | Two renderers, opposite over-cap policies: WebGPU loud-fails at 32, WebGL **silently truncates at 8** and samples an unallocated texture. No over-cap gate. |
| fragment-output-anchor | **HIGH** (narrow) | The fragColor→return write is a single greedy regex in `wgsl-assembler.ts`; 5 of 6 alphaOps unverified. |
| texture-multipass | MED | Sampling is a clean construct + auto-discovered gate; but LOD-under-non-uniform-control-flow and >8-pass depth are ungated (silent frame-drop / truncation). |
| uniforms | MED | Built-ins declared twice per node (`glsl()` Set vs `ir()` Set) + 4 disjoint framework sites; miss one → undeclared-identifier on the untested fallback, or a declared-but-zero phantom (`u_mouse`). |
| control-flow-types | MED | Constructs clean; two parallel coercion tables (silent identity fallback); one-arg `raw()` outside the mechanical-translate regex table → silent WGSL-only fail. |
| color-alpha | MED | Transfer function hand-written twice (legacy string + IR helpers); never-invent-alpha + premultiply-before-average are convention, not enforced. |
| node-identity-naming | MED | Recently hardened (unique ids, gates); residual ~40 copy-pasted `.replace(/-/g,'_')` sanitize literals. |
| shared-fns-raw-budget | MED | Node-body `raw()` at floor (0 two-arg); reeded is the concentration (38). Budget doesn't scan compiler core/renderers — the real drift surface. |

## Punch-list (ranked by trip-risk × nodes-unblocked)
1. **[med] Coordinates → construct.** Replace the 3 `ir-compiler.ts` coord `raw()`s with `fragCoord('yDown')`/`fragCoord('native')`-based IR; migrate pixel-grid/pixelate off `variable('gl_FragCoord.xy')`. *Footing for SRT (SRT re-bases these coords).*
2. **[med] SRT compose → one ordered op-list** `[subAnchor, scale, rotate, translate, addAnchor]`, each backend supplying only syntax; delete the legacy inline copy in `glsl-generator.ts:562-591`; add a perturbation-tested order-parity gate.
3. **[large] Migrate reeded-glass onto `spatial:`** — retire its hand-rolled SRT + coord rebuild (the bypass template + the 38-`raw()` concentration).
4. **[small-med] Unify the multi-pass memory cap** — one shared cap + one over-cap policy (compile-time node-named error, not `console.warn`), + an over-cap gate on both backends.
5. **[tiny] Wire orphaned gates into CI** — `verify:coord-hygiene --strict` + `verify:stream-integrity` into `verify:ci`. Near-zero effort, immediate standing coverage.
6. [med] Built-in uniform registry + `requestBuiltin` + declared==written gate (retires the `u_mouse` phantom).
7. [med] `IRFragmentOutput` statement kind (delete the fragColor→return regex); sweep all anchors + alphaOps.
8. [small-med] Collapse the two coercion tables; type-aware raw `mod`.
9. [med] Single color transfer function (generate GLSL from IR helpers); gate the alpha/linear disciplines.
10. [large] Extract the duplicated multi-pass assembly orchestration (two ~400-line copies) into one shared module + relay/multi-output parity gate.

## SRT readiness (the next target)
**Consistent today, but undefended — consolidate before building on it.**
- The `IRSpatialTransform` **data struct is single-source**, but the compose **order/math is literal strings written 3×** (`glsl-generator.ts:562-591` legacy — reads `inputs.srt_*` directly, ignores the struct; `ir/glsl-backend.ts:197-228`; `ir/wgsl-backend.ts:552-585`) **+ reeded a 4th/5th**.
- **The order is NOT currently wrong or divergent:** all copies agree line-for-line — `coords−anchor → ÷scale → rotate(0.01745329 rad, x·c−y·s / x·s+y·c) → −translate/(u_dpr·u_ref_size) → +anchor`. Backends differ only in syntax. So it's a **drift time-bomb, not a live bug**: correct by hand-verification, pinned by **no gate**.
- **Open question is intent, not consistency:** whether scale→rotate→translate *in that composition* is the desired semantics is a design call (the "wrong order" concern). One op-list makes changing it a one-place edit.
- **Bypass:** reeded-glass only — declares `getSpatialParams(...)` as **params** with **no `spatial:` key**, so framework injection (`ir-compiler.ts:277`) never fires; it also re-hand-writes `auto_uv`. The other 9 spatial nodes consume framework coords cleanly.
- **Consolidation:** (a) express the ordered op-list once, backends supply only `vec2`/`f32` syntax; (b) delete the legacy inline copy, route through the one source; (c) migrate reeded onto `spatial:`; (d) mechanism-engaged order-parity gate (compile a real spatial node both backends, assert identical order, perturb one, confirm fail). Do coordinate consolidation (#1) first — SRT re-bases those coords.

## Readiness by node type (answer to "how far from focusing on nodes")
- **Simple / pointwise:** SAFE NOW. Well-gated (byte-identical cross-backend GPU for control flow; raw-budget at 0). Ship these.
- **Spatial:** safe **only if** it declares `spatial:` + consumes `ctx.inputs.coords`. Two trip vectors: copying reeded's bypass, or reaching for `gl_FragCoord` (→ vertically-mirrored on WebGPU only). No gate pins SRT order or Y-parity. **Punch #1+#2+#3 clears this.**
- **Multi-pass / texture:** mostly safe for sampling; risky at depth (LOD-under-control-flow silent fail; >8 passes silent WebGL truncation). **Punch #4 clears the memory cliff.**

## The pattern to internalise
Extend `verify-raw-budget`'s scope **and the mechanism-engaged-gate discipline** to the compiler core + renderers. The "0 hand-written two-arg" number is true and worth keeping, but it certifies only node-body shader text; the foundational concerns are hand-lowered twice one layer up, where no budget counts them.
