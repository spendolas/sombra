# Wires Into Dynamic Params Are Deleted — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `.sombra` file loading and schema migration from silently deleting edges that target connectable **dynamic** params.

**Architecture:** Both paths validate an edge's `targetHandle` against a set of "valid handles" assembled from the node definition. Both resolve `dynamicInputs` correctly and then read the **static** `def.params` for connectable params — the same asymmetry `dynamicParams` resolution fixed inside the compiler, surviving in two places outside it. `resolveParams` already exists (`src/nodes/resolve-dynamic.ts`); this points the two survivors at it.

**Tech Stack:** TypeScript (strict), `tsx` scripts as the test suite, Zustand persist, `@xyflow/react` graph types.

**Spec:** `docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md` §13b
**Blocking for:** the Stack node — a node whose layer opacities can be wired is exactly what turns this latent gap into lost work.

## Why this is not cosmetic

A user wires a Noise into layer 3's opacity, saves the graph, reopens the file —
**the wire is gone, with no error.** They rewire it, it works, they save again.
The file-open path has no version gate, no migration, nothing: it happens every
time. The graph they saved is not the graph they get back.

The second site is rarer but worse-shaped: it lives inside zustand's `migrate`,
which runs only when `GRAPH_SCHEMA_VERSION` changes. So the wire survives normal
use indefinitely and then vanishes the next time anyone bumps the schema — long
after the change that caused it, in a build nobody connects to the loss.

## Global Constraints

- **A gate must be seen to fail.** Both sites need a case that fails before the
  fix. Paste the failure output into the report.
- **Mechanism-engaged assertions.** Assert the edge **survives the round trip**,
  not that the function returns. Both functions return happily today while
  dropping the edge.
- **Both sites, one plan, separate commits.** They are the same bug in two
  places; fixing one and not the other leaves the feature half-safe.
- **Do not push.** `main` deploys to sombra.sh on push.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **The code in this plan has never been run.** Where a signature differs, the
  source wins — fix it and say so.
- **A line number is a pointer, not a description.** Read the code at every
  line this plan cites before changing it. This plan exists because a site was
  characterised from an adjacent line number rather than from its own code.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/verify-dynamic-param-edges.ts` | **Create.** Gate: an edge into a connectable dynamic param survives a `.sombra` round trip and a `migrate`. |
| `src/utils/sombra-file.ts:374-386` | **Modify.** The load-time prune in `importFromFile`. |
| `src/stores/graphStore.ts:465-471` | **Modify.** `migrate`'s `validHandles`. |
| `package.json` | **Modify.** Register the gate, add to `verify:ci`. |

---

### Task 1: Gate proving both paths delete the edge

**Files:**
- Create: `scripts/verify-dynamic-param-edges.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `exportToFile` / `importFromFile` from `src/utils/sombra-file`, `nodeRegistry`, `resolveParams`
- Produces: `npm run verify:dynamic-param-edges`

- [ ] **Step 1: Write the failing gate**

```ts
/**
 * Does an edge into a connectable DYNAMIC param survive persistence?
 *
 * Two places validate an edge's targetHandle against a set built from the node
 * definition. Both resolve dynamicInputs and then read the STATIC def.params for
 * connectable ones, so a handle that exists only through dynamicParams is not in
 * the set and the edge is silently dropped.
 *
 * The assertions check that the EDGE SURVIVES, not that the function returns —
 * both functions return happily today while deleting it.
 *
 * Run: npx tsx scripts/verify-dynamic-param-edges.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { exportToFile, importFromFile } from '../src/utils/sombra-file'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition, NodeParameter } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const gain = (i: number): NodeParameter => ({
  id: `gain_${i}`, label: `Gain ${i}`, type: 'float', default: 0.5,
  min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
})

/**
 * `gain_0` is static, `gain_1` exists only through dynamicParams. Both are
 * wired. The static one must survive (proving the fixture works); the dynamic
 * one is the bug.
 */
const testNode: NodeDefinition = {
  type: 'test_dyn_param_edges',
  label: 'Test Dynamic Param Edges',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [gain(0)],
  dynamicParams: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.gainCount) || 1))
    return Array.from({ length: count }, (_, i) => gain(i))
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = ${ctx.inputs.color};`,
  ir: (ctx) => ({
    statements: [],
    uniforms: [],
    standardUniforms: new Set<string>(),
    // Body intentionally trivial — this gate is about persistence, not codegen.
    ...(ctx ? {} : {}),
  }),
}
nodeRegistry.register(testNode)

function graph() {
  const nodes = [
    n('a', 'checkerboard'),
    n('g0', 'gradient'),
    n('g1', 'gradient'),
    n('fx', 'test_dyn_param_edges', { gainCount: 2 }),
    n('out', 'fragment_output'),
  ]
  const edges = [
    e('e0', 'a', 'color', 'fx', 'color'),
    e('e1', 'g0', 'value', 'fx', 'gain_0'),   // static param — must survive
    e('e2', 'g1', 'value', 'fx', 'gain_1'),   // DYNAMIC param — the bug
    e('e3', 'fx', 'color', 'out', 'color'),
  ]
  return { nodes, edges }
}

test('a .sombra round trip keeps the wire into a dynamic param', () => {
  const { nodes, edges } = graph()
  const json = exportToFile(nodes as never, edges as never)
  const back = importFromFile(typeof json === 'string' ? JSON.parse(json) : json)
  const ids = back.edges.map((x) => x.id)
  assert(ids.includes('e1'), 'the STATIC param wire was dropped — the fixture is wrong, fix it before reading anything else')
  assert(ids.includes('e2'),
    `the wire into the dynamic param gain_1 was deleted on load. Survivors: ${JSON.stringify(ids)}`)
})

run('dynamic-param-edges')
```

**Note on `exportToFile`'s signature:** read it at `src/utils/sombra-file.ts:45`
before writing this call. If it takes more arguments or returns something other
than a JSON string, adapt and report. The `typeof json === 'string'` hedge above
is a guess and should be replaced by the real shape once you know it.

- [ ] **Step 2: Register and run it**

```json
"verify:dynamic-param-edges": "tsx scripts/verify-dynamic-param-edges.ts",
```

Run: `npm run verify:dynamic-param-edges`
Expected: the first assertion PASSES (static wire survives), the second FAILS
(`e2` missing). That asymmetry is the whole point — it proves the fixture is
sound and isolates the bug to dynamic params.

If the *static* assertion fails, stop: something about the fixture or the export
shape is wrong, and the dynamic result would mean nothing.

- [ ] **Step 3: Commit the failing gate**

```bash
git fetch origin && git checkout -b fix/dynamic-param-wire-loss origin/main
git add scripts/verify-dynamic-param-edges.ts package.json
git commit -m "test(verify): gate wires into connectable dynamic params

Fails on main: importFromFile's dangling-handle prune resolves dynamicInputs but
reads static def.params for connectable ones, so a wire into a dynamic param is
deleted on every .sombra open. Asserts the edge survives the round trip, not
that the function returns — it returns happily today while dropping it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Fix the file-load prune

**Files:**
- Modify: `src/utils/sombra-file.ts:374-386`

- [ ] **Step 1: Read the prune**

It currently reads:

```ts
    const tgtInputs = tgtDef.dynamicInputs ? tgtDef.dynamicInputs(tgt.data.params || {}) : tgtDef.inputs
    const tgtOk = !e.targetHandle
      || tgtInputs.some((p) => p.id === e.targetHandle)
      || (tgtDef.params ?? []).some((p) => p.connectable && p.id === e.targetHandle)
```

Note the asymmetry on consecutive lines: `dynamicInputs` resolved, `params` not.

- [ ] **Step 2: Resolve params the same way**

```ts
    const tgtInputs = tgtDef.dynamicInputs ? tgtDef.dynamicInputs(tgt.data.params || {}) : tgtDef.inputs
    // Params must be resolved exactly as inputs are: a handle that exists only
    // through dynamicParams is still a real handle, and treating it as invalid
    // deletes the user's wire on every file open.
    const tgtParams = resolveParams(tgtDef, tgt.data.params as Record<string, unknown> | undefined)
    const tgtOk = !e.targetHandle
      || tgtInputs.some((p) => p.id === e.targetHandle)
      || tgtParams.some((p) => p.connectable && p.id === e.targetHandle)
```

with `import { resolveParams } from '../nodes/resolve-dynamic'` at the top —
check the correct relative path from `src/utils/`.

- [ ] **Step 3: Run the gate**

Run: `npm run verify:dynamic-param-edges`
Expected: PASS.

- [ ] **Step 4: Prove nothing else changed**

Run: `npx tsc -b && npm run lint && npm run verify:ci && npm run self-validate`
Expected: all pass, `self-validate` 0 FAIL / 0 WARN.

Then load a real `.sombra` file through the UI (dev server via `preview_start`,
never `npm run dev` in a shell) and confirm the graph arrives intact. Existing
files contain no dynamic params, so this is a regression check on the common path.

- [ ] **Step 5: Perturb**

Revert the change, confirm the gate fails again, restore.

- [ ] **Step 6: Commit**

```bash
git add src/utils/sombra-file.ts
git commit -m "fix(file): keep wires into connectable dynamic params on load

importFromFile's dangling-handle prune resolved dynamicInputs and then read the
static def.params on the very next line, so a handle existing only through
dynamicParams looked invalid and its edge was dropped. Runs on every .sombra
open — no version gate, no migration. Save a graph with a wired layer opacity,
reopen it, the wire was gone with no error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Fix the migrate prune

**Files:**
- Modify: `src/stores/graphStore.ts:465-471`
- Modify: `scripts/verify-dynamic-param-edges.ts` (add the migrate case)

`migrate` runs only when the persisted version differs from
`GRAPH_SCHEMA_VERSION`, so this fires on a schema bump rather than a reload —
rarer than Task 2, and worse-shaped: the wire survives normal use indefinitely
and then vanishes in a build nobody connects to the loss.

- [ ] **Step 1: Extend the gate first**

`migrate` is a closure inside the `persist` config and is not directly callable.
Two options, in order of preference:

1. **If `migrate` can be reached** — e.g. the store exposes it, or the persist
   options object is exported — call it with a persisted-shaped object
   `{ nodes, edges }` at an older version and assert `e2` survives.
2. **If it cannot**, assert on the shared logic instead: extract the
   `validHandles` construction into an exported helper
   (`buildValidHandles(def, nodeParams): Set<string>`) in `graphStore.ts`, call
   that from `migrate`, and have the gate assert the returned set contains
   `gain_1`. State in your report which option you took and why.

Either way the new case must **fail before Step 2** and be seen to.

- [ ] **Step 2: Resolve params in `validHandles`**

```ts
            const validHandles = new Set([
              ...def.inputs.map(i => i.id),
              ...def.outputs.map(o => o.id),
              // Same resolution as dynamicInputs below: a connectable dynamic
              // param is a real handle, and calling it invalid deletes the edge.
              ...resolveParams(def, targetNode.data.params).filter(p => p.connectable).map(p => p.id),
              ...(def.dynamicInputs?.(targetNode.data.params || {}).map(i => i.id) ?? []),
            ])
```

- [ ] **Step 3: Run everything**

Run: `npm run verify:dynamic-param-edges && npm run verify:ci && npm run self-validate`
Expected: all pass.

- [ ] **Step 4: Perturb and commit**

Revert, confirm the migrate case fails, restore, then:

```bash
git add src/stores/graphStore.ts scripts/verify-dynamic-param-edges.ts
git commit -m "fix(store): keep wires into connectable dynamic params through migrate

The same asymmetry as the file loader: validHandles resolved dynamicInputs but
read static def.params for connectable ones. Fires only when
GRAPH_SCHEMA_VERSION changes, so a wire survives normal use indefinitely and
then vanishes at the next schema bump — long after the change that caused it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Add to `verify:ci` and sweep for siblings

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the gate to `verify:ci`.** Node-only.

- [ ] **Step 2: Sweep for the same asymmetry**

Run:

```bash
grep -rn "dynamicInputs" src/ | grep -v "resolve-dynamic\|node_modules"
```

For **every** hit, check whether the same function also reads `def.params`
without `resolveParams`. §13b lists the ones known as of 2026-09-13
(`layout.ts:37-38,115`, `sombra-file.ts:366,584`, `embed/manifest.ts:81`,
`dev-bridge.ts:59,277,800`, `CommandPalette.tsx:129`,
`PreviewGizmoOverlay.tsx:156`) — **confirm that list is still complete and report
any site it misses.** Do not fix them here; this plan is the two that delete data.

- [ ] **Step 3: Commit and stop**

No push, no merge. Report with: the Task 1 failure output showing the static wire
surviving while the dynamic one dies, which option you took for the migrate gate,
both perturbation results, and the sweep's findings.

---

## What this plan deliberately does NOT do

- **No fix for the other seven sites.** They fail visibly or gracefully; these
  two delete data. One concern.
- **No `dynamicInputs`/`dynamicParams` unification.** Tempting while here —
  every one of these sites would become a single call — but it is a refactor,
  not this bug.
