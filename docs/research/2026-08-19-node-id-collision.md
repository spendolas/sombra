# Duplicate node ids — wrong previews + cross-node math entanglement

**Date:** 2026-08-19 · **Branch:** `fix/node-id-collision` · **Status:** fixed, awaiting human QA

## Symptoms reported

1. A node's mini-preview sometimes shows a **different node's** preview. Sometimes resets when the node is plugged/connected, but not reliably.
2. Some nodes **affect other nodes' math** in a non-sequential way — a plumbing / entanglement issue.

## Root cause (single, for both symptoms)

Node ids were minted as `` `${nodeType}-${Date.now()}` `` at both UI creation sites:

- `src/components/FlowCanvas.tsx:201` (drag-drop add)
- `src/components/CommandPalette.tsx:137` (Cmd+K add)

`Date.now()` has millisecond resolution and there is no counter/uuid/uniqueness check (`graphStore.addNode` just appends). **Two same-type nodes minted in the same millisecond get an identical id.** A graph persisted before this fix can also carry a duplicate id baked into `localStorage` / a `.sombra` file / a share URL — which is why the bug felt chronic and intermittent: it survives every reload until repaired.

Every downstream identifier is derived from the node id, so a duplicate id collapses them all onto one key:

- **Preview store** — `previews[nodeId]` (`ShaderNode.tsx:31`, keyed by the node's own id). Two nodes sharing an id read the same bitmap → one shows the other's preview. Bug 1.
- **Compiler (silent)** — `topologicalSort`'s visited-Set (`topological-sort.ts:56`) and BOTH codegen paths' `new Map(nodes.map(n => [n.id, n]))` (`glsl-generator.ts:654`, `ir-compiler.ts:460`) keep only the **last** node with a given id, and `topologicalSort` merges incoming edges by target id. One node silently shadows the other; every uniform name (`u_<id>_<param>`), variable name (`node_<id>_<port>`), fast-path uniform route (`use-live-compiler.ts`), and renderer uniform location / buffer offset (`webgl/renderer.ts`, `webgpu/renderer.ts`) is then shared. Changing one node drives the other's math. Bug 2. It compiles cleanly — no redeclaration error — because the collapse happens *before* any identifier is emitted.

Secondary contributor to Bug 1: `previewStore.clearNodes` had **zero callers** — a deleted node's bitmap was never purged, so a later node that reacquired the id inherited the ghost image.

Ruled out (by investigation, not assumption): renderer buffer bleed, index/order result-matching in the preview scheduler, and `addFunction` registry aliasing — all correctly keyed *given unique ids*. The duplicate id is the only silent cross-node collision.

## Fix

One concern — node-id uniqueness end-to-end:

1. **Unique mint.** New `src/utils/node-id.ts` → `makeNodeId(type)` = `` `${type}-${uuid}` `` (crypto.randomUUID, with a counter+random fallback). Keeps the readable type prefix (flows into shader var names / error mapping). Wired at `FlowCanvas.tsx` and `CommandPalette.tsx`. `dev-bridge.createNode` already used a safe counter — unchanged.
2. **Repair already-poisoned graphs.** `dedupeNodeIds(nodes, edges)` reassigns every later duplicate a fresh id (first occurrence keeps the id; edges bind to it). Called in `graphStore.loadGraph` (file/import/share) and in the persist `migrate` (localStorage) — schema version bumped **3 → 4** so it runs once for existing users. Logs a `console.warn` when it repairs, so QA can see it fire.
3. **Purge stale previews on delete.** `preview-scheduler.onGraphChange` now calls `previewStore.clearNodes(departed)` for nodes that left the graph.

## Verification

- New gate `scripts/verify-node-id.ts` (`npm run verify:node-id`, folded into `verify:ci`):
  - `makeNodeId`: 200 000 ids minted in one synchronous tick are all unique (this assertion *fails* under the old `Date.now()` scheme).
  - **Property:** two unique-id gradients → `mix(a,b)` → output compile to **2 distinct** `node_<id>_color` vars + 2 distinct uniform nodeIds.
  - **Control (mechanism-engaged, per the repo's anti-vacuous-gate rule):** the same graph with a **shared** id collapses to **1** var, and `mix.a`/`mix.b` both read it — proving the metric genuinely detects entanglement and that perturbing unique→shared flips 2→1.
  - `dedupeNodeIds` repairs a poisoned graph to all-unique and is a reference-equal no-op when clean.
- `npm run verify:ci` — all pass (ir-poc 85, wgsl-multipass 159, raw-budget, pass-size, pass-resolution, ir-control-flow, wired-branch, node-id).
- `npm run lint` clean · `npm run build` clean (app + embed bundle) · `tsc -b` clean.

## Human QA checklist (morning)

Not verified in a live browser (the original bug can't be reproduced through the dev bridge, whose `createNode` was already safe; timing-based UI collisions are non-deterministic). Suggested manual checks:

1. **Existing graph repair:** open the app with your current saved graph. Watch the console for `[graph] migrate: reassigned N duplicate node id(s)`. If it fires, the entanglement/preview weirdness on that graph should be gone.
2. **Rapid add:** add several same-type nodes fast (drag-drop and Cmd+K). Each should get its own preview; wiring/param changes on one must not affect another.
3. **Delete → re-add:** delete a node with a live preview, add a new one — no ghost thumbnail.
4. **Load a `.sombra` / share URL** that was saved earlier — should load clean (dedupe runs on load too).

## Not done (deliberately)

- Not committed to `main`, not pushed, not merged — left on `fix/node-id-collision` for your QA.
- Edge disambiguation for repaired duplicates is best-effort (edges follow the first occurrence; the reassigned copy is unwired). A pre-fix duplicate pair had no distinct edge set to recover.
