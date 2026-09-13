# Relay Pass Pruning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop relay passes re-emitting the whole pass body, so shader size grows linearly with converging branches instead of quadratically.

**Architecture:** When several independent branches sit at the same pass depth and each must become a texture, the compiler emits one primary pass plus one *relay* per extra source output. Every relay currently copies the entire pass body and changes only its final `fragColor` assignment (`glsl-generator.ts:861` — `const relayLines = [...bodyLines, resolved.fragLine]`), so N converging branches produce N passes each containing all N bodies. The fix is to attribute emitted lines to the node that produced them — the generator already receives them per node at `:848` and merely flattens them — then emit into each relay only the lines its own output actually depends on.

**Tech Stack:** TypeScript (strict), `tsx` scripts as the test suite, GLSL ES 3.0 + WGSL codegen.

**Spec:** `docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md` (§4 "What the chain does NOT fix", §6.4)
**Audit:** `docs/audit/2026-09-11-stack-node-failure-modes.md` (P2.1)

## Why this is required, not an optimisation

The Stack node composites layers in a chain, so its *compositing* is sequential.
But its N layer **sources** are still independent branches at depth 0, and each
must become a texture — so they still split into relays. Sequencing the
compositing does not avoid this. Without pruning, a 10-layer Stack emits ten
passes each carrying all ten chains; at 60 layers it is roughly 3,600 chain
bodies and megabytes of shader, and **there is no shader-size guard anywhere** in
the compiler, worker or renderers.

## Global Constraints

- **Both backends.** The GLSL path (`glsl-generator.ts:902-925`) and the IR path
  (`ir-compiler.ts:734-752`) have separate relay implementations. Both need it.
- **Output must be semantically identical.** This is a size fix, not a behaviour
  change: every pass must still compute the same `fragColor` from the same inputs.
  The gates below assert rendered-pixel equality, not just smaller shaders.
- **A gate must be seen to fail.** Write the size assertion first and watch it
  fail on unmodified source.
- **Mechanism-engaged assertions.** Assert *line counts per relay* and
  *pixel equality*, together. Size alone passes if you emit a broken tiny shader;
  equality alone passes if you change nothing.
- **One concern per commit. Do not push** — `main` deploys on push.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **The code in this plan has never been run.** Where a signature differs, the
  source wins — fix it and say so in your report.

## File Structure

| File | Responsibility |
|---|---|
| `src/compiler/reachability.ts` | **Create.** `nodesFeeding(startNodeId, edgesByTarget)` — the set of nodes an output depends on, within a pass. |
| `src/compiler/glsl-generator.ts` | **Modify.** Accumulate lines as per-node segments; emit only reachable segments into each relay. |
| `src/compiler/ir-compiler.ts` | **Modify.** Same change on the IR path's relay loop. |
| `scripts/verify-relay-pruning.ts` | **Create.** The gate: size and equality together. |

---

### Task 1: Reachability helper

**Files:**
- Create: `src/compiler/reachability.ts`
- Test: covered by Task 2's gate (this helper is pure and exercised there)

**Interfaces:**
- Produces: `nodesFeeding(startNodeId: string, edgesByTarget: Map<string, Edge[]>, within: Set<string>): Set<string>`

- [ ] **Step 1: Write it**

```ts
import type { Edge } from '@xyflow/react'

/**
 * Every node whose output `startNodeId` depends on, restricted to `within`.
 *
 * Used to prune relay passes: a relay computes one source output, so it only
 * needs the lines of the nodes feeding that output. The `within` set confines
 * the walk to a single pass — nodes in earlier passes arrive as textures, not
 * as inline code, and must not be pulled in.
 *
 * Iterative rather than recursive, and `seen`-guarded, so a cyclic graph that
 * arrived from a file (the editor refuses to draw one, but a shared URL can
 * carry one) terminates instead of hanging the worker.
 */
export function nodesFeeding(
  startNodeId: string,
  edgesByTarget: Map<string, Edge[]>,
  within: Set<string>,
): Set<string> {
  const seen = new Set<string>()
  const stack = [startNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id) || !within.has(id)) continue
    seen.add(id)
    for (const edge of edgesByTarget.get(id) ?? []) stack.push(edge.source)
  }
  return seen
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc -b
git checkout -b perf/relay-pruning
git add src/compiler/reachability.ts
git commit -m "feat(compiler): reachability helper for pass-local pruning

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Gate proving relays carry the whole body

**Files:**
- Create: `scripts/verify-relay-pruning.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `compileGraph`, `compileGraphIR`
- Produces: `npm run verify:relay-pruning`

- [ ] **Step 1: Write the failing gate**

```ts
/**
 * Do relay passes carry only the code their own output needs?
 *
 * When several branches converge at one pass depth, each extra source output
 * becomes a relay pass. Relays re-emit the ENTIRE pass body and change only the
 * final assignment, so N converging branches produce N passes carrying N bodies:
 * shader text grows with N squared. The Stack node makes that routine.
 *
 * This asserts size AND equality together on purpose. Size alone passes if you
 * emit a broken tiny shader; equality alone passes if you change nothing.
 *
 * Run: npx tsx scripts/verify-relay-pruning.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

/**
 * `branches` independent noise→pixelate chains, all converging into a chain of
 * mixes. Each pixelate's `source` is a textureInput, so every branch becomes its
 * own boundary at the same depth — the relay-producing shape.
 *
 * Distinct noise `seed` values per branch matter: identical branches could in
 * principle be deduplicated by some later optimisation, and this gate must keep
 * measuring relays rather than accidentally measuring CSE.
 */
function convergingGraph(branches: number) {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const tips: string[] = []
  for (let i = 0; i < branches; i++) {
    // gradient, NOT noise: noise's only output is `value` (float), so a
    // `color` edge from it is rejected before the bug can be reached
    // (noise.ts:25, gradient.ts:43).
    nodes.push(n(`src${i}`, 'gradient', { angle: i * 15 }))
    nodes.push(n(`fx${i}`, 'pixelate'))
    edges.push(e(`ea${i}`, `src${i}`, 'color', `fx${i}`, 'source'))
    tips.push(`fx${i}`)
  }
  let acc = tips[0]
  for (let i = 1; i < tips.length; i++) {
    const mixId = `mix${i}`
    nodes.push(n(mixId, 'mix'))
    // mix's output is `result`, not `color` (mix.ts:31). Its inputs are a/b.
    edges.push(e(`em${i}a`, acc, i === 1 ? 'color' : 'result', mixId, 'a'))
    edges.push(e(`em${i}b`, tips[i], 'color', mixId, 'b'))
    acc = mixId
  }
  nodes.push(n('out', 'fragment_output'))
  edges.push(e('eout', acc, branches > 1 ? 'result' : 'color', 'out', 'color'))
  return { nodes, edges }
}

// The two backends name their shader field DIFFERENTLY. RenderPass has
// `fragmentShader` (glsl-generator.ts:56); WGSLPassOutput has `shaderCode`
// (ir-compiler.ts:457) and no `fragmentShader` at all — reading the wrong one
// yields undefined.length and the size comparison measures nothing.
const glslChars = (plan: { passes: Array<{ fragmentShader: string }> }) =>
  plan.passes.reduce((sum, p) => sum + p.fragmentShader.length, 0)
const wgslChars = (plan: { passes: Array<{ shaderCode: string }> }) =>
  plan.passes.reduce((sum, p) => sum + p.shaderCode.length, 0)

test('GLSL: total shader size grows sub-quadratically with converging branches', () => {
  const g2 = convergingGraph(2), g6 = convergingGraph(6)
  const two = compileGraph(g2.nodes, g2.edges)
  const six = compileGraph(g6.nodes, g6.edges)
  assert(two.success && six.success, 'compile failed')
  const ratio = glslChars(six) / glslChars(two)
  // 3x the branches. Linear-ish growth lands near 3-5x; quadratic re-emission
  // lands near 9x or above. The threshold is deliberately loose — this measures
  // an asymptote, not an exact size.
  assert(ratio < 6,
    `shader size grew ${ratio.toFixed(1)}x for 3x the branches — relays are still re-emitting whole bodies`)
})

test('GLSL: a relay contains fewer lines than the primary pass', () => {
  const { nodes, edges } = convergingGraph(4)
  const plan = compileGraph(nodes, edges)
  assert(plan.success, 'compile failed')
  const lens = plan.passes.map((p) => p.fragmentShader.split('\n').length)
  const primary = Math.max(...lens)
  const relays = lens.filter((l) => l !== primary)
  assert(relays.length > 0, 'no relay passes were produced — the fixture is wrong')
  assert(relays.some((l) => l < primary),
    `every pass is the same size (${primary} lines) — relays still carry the full body`)
})

test('WGSL: same, on the IR path', () => {
  const g2 = convergingGraph(2), g6 = convergingGraph(6)
  const two = compileGraphIR(g2.nodes, g2.edges)
  const six = compileGraphIR(g6.nodes, g6.edges)
  // No `success` field on this path — null is the only failure signal.
  assert(two !== null && six !== null, 'IR compile returned null')
  const ratio = wgslChars(six!) / wgslChars(two!)
  assert(ratio < 6,
    `WGSL shader size grew ${ratio.toFixed(1)}x for 3x the branches`)
})

test('every pass still declares its own fragColor exactly once', () => {
  const { nodes, edges } = convergingGraph(4)
  const plan = compileGraph(nodes, edges)
  for (const p of plan.passes) {
    const assignments = (p.fragmentShader.match(/fragColor\s*=/g) ?? []).length
    assert(assignments === 1,
      `a pass assigns fragColor ${assignments} times — pruning broke pass assembly`)
    assert(!p.fragmentShader.includes('undefined'), 'pruned shader contains "undefined"')
  }
})

run('relay-pruning')
```

- [ ] **Step 2: Register and run it**

```json
"verify:relay-pruning": "tsx scripts/verify-relay-pruning.ts",
```

Run: `npm run verify:relay-pruning`
Expected: tests 1–3 FAIL. Record the actual growth ratio — that number is the
headline result of this work, and you will quote it again after the fix.

If test 2 reports "no relay passes were produced", the fixture is not creating
converging boundaries; fix the fixture before going further, because the rest of
the plan would then be measuring nothing.

- [ ] **Step 3: Commit the failing gate**

```bash
git add scripts/verify-relay-pruning.ts package.json
git commit -m "test(verify): gate relay pass size

Fails on main: relay passes re-emit the entire pass body, so shader text grows
quadratically in converging branches. Asserts size growth AND per-pass fragColor
integrity together — size alone would pass for a broken tiny shader.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Attribute emitted lines to their node (GLSL path)

**Files:**
- Modify: `src/compiler/glsl-generator.ts` around `:840-860`

**Interfaces:**
- Produces: a local `segments: Array<{ nodeId: string; lines: string[] }>` alongside the existing flat `glslLines`

This task changes **no output**. It only records which node produced which lines,
so Task 4 can prune. Keeping it separate means Task 4's diff is small enough to
review honestly.

- [ ] **Step 1: Record segments as you flatten**

At `glsl-generator.ts:848`, where node results are pushed:

```ts
      glslLines.push(...result.glslLines)
```

add, immediately after:

```ts
      segments.push({ nodeId, lines: result.glslLines })
```

declaring `const segments: Array<{ nodeId: string; lines: string[] }> = []`
beside the `glslLines` declaration for that pass.

- [ ] **Step 2: Assert the two agree**

Temporarily, right before the relay loop, add:

```ts
      const flat = segments.flatMap((s) => s.lines)
      if (flat.length !== glslLines.length) {
        throw new Error(`segment drift: ${flat.length} vs ${glslLines.length}`)
      }
```

Run `npm run verify:ci` and `npm run self-validate`. If the throw fires, lines
are being pushed to `glslLines` somewhere other than `:848` — find that site and
record it in segments too, then report it. **Remove the temporary check before
committing.**

- [ ] **Step 3: Commit**

```bash
git add src/compiler/glsl-generator.ts
git commit -m "refactor(compiler): attribute emitted GLSL lines to their node

No output change. Records which node produced which lines so relay passes can
emit only what their own output depends on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Prune the GLSL relays

**Files:**
- Modify: `src/compiler/glsl-generator.ts:902-925` (the relay loop)

**Interfaces:**
- Consumes: `nodesFeeding` (Task 1), `segments` (Task 3)

- [ ] **Step 1: Prune**

In the relay loop, replace:

```ts
        const relayLines = [...bodyLines, resolved.fragLine]
```

with:

```ts
        // A relay computes ONE source output, so it needs only the nodes feeding
        // that output. Re-emitting the whole body is what made shader text grow
        // quadratically in converging branches.
        const edge = resolveSourceEdge(groups[g][0], edgesByTarget)
        const needed = edge
          ? nodesFeeding(edge.source, edgesByTarget, new Set(passes[passIdx]))
          : null
        const relayBody = needed
          ? segments.filter((s) => needed.has(s.nodeId)).flatMap((s) => s.lines)
          : bodyLines
        const relayLines = [...relayBody, resolved.fragLine]
```

The `needed ? … : bodyLines` fallback is deliberate: if the source edge cannot be
resolved, emit the full body as before. A relay that renders correctly but large
is a performance regression; one that renders wrong is a broken image.

Note `passes[passIdx]` here is the compiler's **node grouping** for the pass (the
partition), not the output `passes` array being built — confirm the identifier at
that point in the file and use the correct one.

- [ ] **Step 2: Run the gate**

Run: `npm run verify:relay-pruning`
Expected: GLSL tests pass; the WGSL test still fails (Task 5 fixes it).
Record the new growth ratio against the one from Task 2.

- [ ] **Step 3: Prove the output is unchanged**

Run: `npm run verify:ci && npm run self-validate`
Expected: 0 FAIL / 0 WARN.

Then the visual check, which is the one that matters — a pruned relay that drops
a needed line produces a *plausible* wrong image, not an error:

Start the dev server via `preview_start` (never `npm run dev` in a shell). Build a
graph with two blurred branches converging into a mix, screenshot it, then
`git stash` the pruning change, reload, and screenshot again. The two must match.
`git stash pop` afterwards. Report both screenshots.

- [ ] **Step 4: Perturb**

Make `nodesFeeding` return only the start node (`return new Set([startNodeId])`)
and confirm the fragColor-integrity test or the visual check fails — an
over-aggressive prune must be caught by this gate, not just an under-aggressive
one. Restore.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/glsl-generator.ts
git commit -m "perf(compiler): relay passes emit only their own reachable nodes

A relay computes one source output but re-emitted the entire pass body, so N
converging branches produced N passes carrying N bodies. Shader text now grows
linearly in branches.

Measured: <ratio before> -> <ratio after> for 3x the branches.

Falls back to the full body when the source edge cannot be resolved: a large
relay is a perf regression, a wrong one is a broken image.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The same on the IR path

**Files:**
- Modify: `src/compiler/ir-compiler.ts:734-752`

- [ ] **Step 1: Read the IR relay loop**

It mirrors the GLSL one but works on IR statements rather than strings — around
`const relayOutputs = [...bodyOutputs, resolved.fragOutput]`. Identify the
statement accumulator that corresponds to `glslLines`.

- [ ] **Step 2: Apply the same two changes**

Record per-node segments where node IR is appended, then filter by
`nodesFeeding(...)` in the relay loop, with the same full-body fallback.

- [ ] **Step 3: Run the gate**

Run: `npm run verify:relay-pruning`
Expected: all four tests pass.

- [ ] **Step 4: GPU-validate**

Run: `npm run self-validate` and `npx tsx scripts/validate-wgsl-multipass.ts`
Expected: no new failures. WGSL is stricter than GLSL about undeclared
identifiers, so an over-aggressive prune surfaces here as a compile error rather
than a wrong image — this is the most valuable check in the plan.

- [ ] **Step 5: Commit**

```bash
git add src/compiler/ir-compiler.ts
git commit -m "perf(compiler): prune IR relay passes too

Same change as the GLSL path. WGSL compilation is the stricter check: an
over-aggressive prune fails to compile rather than rendering a plausible wrong
image.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Add the gate to `verify:ci`

- [ ] **Step 1:** Append `&& npm run verify:relay-pruning` to `verify:ci`.
- [ ] **Step 2:** Run `npm run verify:ci`, expect exit 0.
- [ ] **Step 3:** Commit, then **stop — no push, no merge.**

Report with: the growth ratios before and after on both backends, the two
screenshots from Task 4 Step 3, the perturbation result, and `self-validate`
FAIL/WARN plus shader counts before and after.

---

## What this plan deliberately does NOT do

- **No per-sub-pass edge routing, no sourceless chain expansion.** Those are
  `expand-passes.ts` changes for the Stack's accumulate chain — a separate plan,
  because they change which edges reach which sub-pass rather than how much code
  a pass carries.
- **No liveness-based texture reuse.** That is a renderer change, and its design
  depends on the pass graph this plan reshapes — worth planning *after* the
  measured ratios above exist, not before.
- **No shader-size guard.** Worth adding eventually (there is none anywhere), but
  it is a separate safety net, not part of making relays small.
