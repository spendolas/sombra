# Consumer-Ordered Pass Emission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder a finished plan so each pass is produced close to the pass that consumes it, turning the companion plan's *linear* memory into *constant* memory.

**Architecture:** `partitionPasses` groups nodes by depth, so a Stack's N layer sources all land at one depth and are emitted as one primary plus N−1 relays — all before the compositing chain begins. Layer 15's texture is therefore produced at pass 15 and first read at pass 31, alive across the whole chain. But a pass that reads nothing can legally sit anywhere before its consumer, so this is a **permutation of the finished pass array plus an index remap** — a pure post-pass beside `assignTextureSlots`, with no change to partitioning, relay grouping, or pass contents.

**Tech Stack:** TypeScript (strict), `tsx` scripts as the test suite, WebGPU + WebGL2.

**Spec:** `docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md` §4
**Companion:** `docs/superpowers/plans/2026-09-13-intermediate-texture-reuse.md` — **ships as a pair with this.** Neither is worth building alone.

## Measured, on compiler-produced plans

| shape | passes | today | + liveness | + this plan |
|---|---|---|---|---|
| plain stack, 16 layers | 32 | 31 | 17 | **3** |
| 8 layers, layer 7 reuses layer 0's source | 15 | 14 | 9 | **4** |
| 8 layers, layer 3 is a multi-pass blur | 18 | 17 | 9 | **4** |
| 4-layer stack inside a 4-layer stack | 15 | 14 | 8 | **4** |

Bounded at three or four across nested and fan-out shapes. Fan-out costs one
extra slot because a shared source stays alive to its last consumer — the
analysis being right, not a special case.

## Two things to say plainly, so nobody expects the wrong win

**On the real corpus this plan changes nothing.** 121 textures today, 114 with
liveness, 114 with both. Real saved graphs are shallow enough to be close to
consumer-ordered already. **This is not a general memory optimisation** — it is
specifically and only what makes a deep Stack scale. Any report claiming a
corpus-wide improvement is measuring something else.

**The bound is 3, not 2.** An earlier hand-built estimate said two; the real
plan needs three because of the primary-plus-relay structure at the source depth.
Hand-built pass lists gave optimistic numbers three separate times during this
work. **Measure on compiler-produced plans.**

## Global Constraints

- **Correctness outranks the saving.** A permutation that moves a pass before
  something it reads produces garbage. Every reordered schedule must be validated:
  no pass may read a later one.
- **The output pass stays last.** Asserted, never assumed.
- **Both compilers, one helper.** Like slot assignment — if only one plan is
  reordered, the two backends disagree and the WebGL2 fallback renders a
  different graph from WebGPU.
- **A gate must be seen to fail**, and must assert the constant-slot property on
  **compiler-produced** plans at several layer counts, including the nested and
  fan-out shapes. Those are what turn a bound back into a best case.
- **Do not push.** `main` deploys to sombra.sh on push.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **The code in this plan has never been run.** Where a signature differs, the
  source wins — fix it and say so.

## What the spike established, so you don't re-derive it

- **Nothing assumes adjacency.** No `passes[i-1]` anywhere.
- **`samplerCompiledIndex` is written and read entirely inside emission** and
  never survives it, so a post-pass does not touch it.
- **WebGL2's `downstreamMap` derives from `inputTextures`**, so remapping those
  carries it along.
- **Relay pruning is unaffected** — grouping happens per depth, before ordering.
- **`resolution` and `textureFilter` travel with their pass**, so a permutation
  cannot separate a pass from its target size or filter hint.

## File Structure

| File | Responsibility |
|---|---|
| `src/compiler/pass-order.ts` | **Create.** `orderPassesByConsumer(passes)` — pure permutation + index remap. |
| `src/compiler/glsl-generator.ts` | **Modify.** Apply before slot assignment. |
| `src/compiler/ir-compiler.ts` | **Modify.** Same. |
| `scripts/verify-pass-order.ts` | **Create.** The gate. |

---

### Task 1: The permutation

**Files:**
- Create: `src/compiler/pass-order.ts`

**Interfaces:**
- Produces: `orderPassesByConsumer<T>(passes: T[], readsOf: (p: T) => number[], remap: (p: T, oldToNew: number[]) => T): T[]`

Generic over the pass type, with `readsOf` and `remap` supplied per backend —
because `inputTextures` is a `Record<samplerName, passIndex>` on the GLSL path
and an `Array<{passIndex, samplerName}>` on the IR path. Writing it generically
is what stops the two drifting.

- [ ] **Step 1: Write it**

The shape: a topological order that schedules each pass **as late as possible
while still preceding its first consumer**, so a source sits next to the composite
that reads it rather than at the front of the plan.

```ts
/**
 * Reorder a finished plan so each pass sits close to the pass that consumes it.
 *
 * partitionPasses groups by DEPTH, so a Stack's N layer sources are emitted as
 * one primary plus N-1 relays before any compositing begins — and layer 15's
 * texture is then alive from pass 15 to pass 31. A pass that reads nothing can
 * legally sit anywhere before its consumer, so the fix is a permutation, not a
 * change to partitioning.
 *
 * Pure and generic: the two backends describe reads differently, and supplying
 * `readsOf`/`remap` per backend is what keeps one implementation.
 */
export function orderPassesByConsumer<T>(
  passes: T[],
  readsOf: (p: T) => number[],
  remap: (p: T, oldToNew: number[]) => T,
): T[] {
  const n = passes.length
  if (n <= 2) return passes

  const reads = passes.map(readsOf)
  // firstConsumer[i] = earliest pass that reads i, or Infinity if none does.
  const firstConsumer = new Array<number>(n).fill(Infinity)
  reads.forEach((srcs, i) => {
    for (const s of srcs) if (s >= 0 && s < n) firstConsumer[s] = Math.min(firstConsumer[s], i)
  })

  const scheduled: number[] = []
  const done = new Set<number>()
  // The output pass must stay last; everything else is free to move.
  const last = n - 1

  const ready = (i: number) => reads[i].every((s) => done.has(s))

  while (scheduled.length < n - 1) {
    const candidates = [...Array(n).keys()].filter(
      (i) => i !== last && !done.has(i) && ready(i),
    )
    if (candidates.length === 0) break   // cycle or unreachable: fall back below
    // Prefer the pass whose consumer comes soonest — that is what keeps a
    // source next to its reader instead of at the front of the plan.
    candidates.sort((a, b) => (firstConsumer[a] - firstConsumer[b]) || (a - b))
    const pick = candidates[0]
    scheduled.push(pick)
    done.add(pick)
  }

  // Anything unscheduled (shouldn't happen) keeps its original relative order,
  // so a pathological plan degrades to today's behaviour rather than breaking.
  for (let i = 0; i < n; i++) if (i !== last && !done.has(i)) scheduled.push(i)
  scheduled.push(last)

  const oldToNew = new Array<number>(n).fill(-1)
  scheduled.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx })
  return scheduled.map((oldIdx) => remap(passes[oldIdx], oldToNew))
}
```

**The fallback at the end is deliberate.** If the ready-set ever empties early —
a cycle, or a read of a pass that does not exist — the function degrades to the
original order rather than emitting a broken schedule. A plan that is merely
un-optimised is a performance outcome; a plan whose passes are out of order is a
wrong image.

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc -b
git fetch origin && git checkout -b perf/consumer-ordered-emission origin/main
git add src/compiler/pass-order.ts
git commit -m "feat(compiler): consumer-ordered pass permutation

Pure, unused so far. Degrades to the original order rather than emitting a
broken schedule if the ready set empties early.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Gate the ordering itself

**Files:**
- Create: `scripts/verify-pass-order.ts`
- Modify: `package.json` (and `verify:ci`)

- [ ] **Step 1: Assert validity before any saving**

The first and most important assertion is not the slot count. It is that the
reordered schedule is **valid**: for every pass, every index it reads is earlier
than itself, and the output pass is last. Write that first and run it over every
shape below before asserting any number.

- [ ] **Step 2: Then assert the bound, on compiler-produced plans**

Build each shape through the real compiler — never a hand-built pass list, which
gave an optimistic number three times during this work — and assert slot counts
after applying both this permutation and `assignTextureSlots`:

| shape | expected slots |
|---|---|
| stack at 2, 4, 8, 16 layers | ≤ 3 at every N |
| 8 layers, one source feeding two layers | ≤ 4 |
| 8 layers, one layer fed by a multi-pass blur | ≤ 4 |
| 4-layer stack nested inside a 4-layer stack | ≤ 4 |

**Assert it is constant across N**, not merely small: `slots(16) === slots(2)` is
the property that distinguishes a bound from a coincidence.

- [ ] **Step 3: Assert the corpus is unchanged**

Run the 41 real saved graphs and assert their total slot count is **the same**
with and without the permutation. That is the measured result, and encoding it
stops a future change quietly regressing real graphs while chasing the Stack case.

- [ ] **Step 4: Perturb**

- Sort candidates by `(a - b)` only, ignoring `firstConsumer` → the constant-slot
  assertion must fail while validity still passes. This is the difference between
  "a valid order" and "the right valid order".
- Remove the output-pass pinning → the output-last assertion must fail.
- Reverse the schedule → validity must fail loudly rather than producing a number.

- [ ] **Step 5: Commit**

---

### Task 3: Apply on both compilers

**Files:**
- Modify: `src/compiler/glsl-generator.ts`, `src/compiler/ir-compiler.ts`

- [ ] **Step 1: Apply before slot assignment, after all passes exist**

Including relays. The permutation must see the finished array or it reorders a
partial plan.

- [ ] **Step 2: Supply `readsOf` and `remap` per backend**

GLSL: `Object.values(p.inputTextures)` to read; remap rewrites that `Record`'s
values. IR: `p.inputTextures.map(t => t.passIndex)`; remap rewrites the array.
**Read both types before writing either.**

- [ ] **Step 3: Verify both plans agree**

Compile the same graph through both paths and assert identical pass *ordering*.
If they diverge, the WebGL2 fallback renders a different graph from WebGPU — the
failure this constraint exists to prevent.

- [ ] **Step 4: Full gates, then live verification**

`verify:ci`, `self-validate` (expect 468/468 with the corpus present and **no
change** — reordering must not alter any shader's content), then in the browser on
**both** backends: a deep chain, a converging graph, and a graph with a multi-pass
blur, compared against `main` screenshots. Reordering changes which buffer a pass
writes; if anything renders differently, stop.

- [ ] **Step 5: Commit and stop**

Report with: the validity assertions, the slot table at each N, the corpus
unchanged-count, all three perturbations, both-backends screenshots, and
confirmation that the two compilers produce identical orderings.

---

## Known risk, to be handled rather than discovered

**The embed artifact bakes a compiled `RenderPlan`.** Plans published after this
lands are ordered differently from plans published before. Already-published
embeds carry their own baked plan and are unaffected — they do not recompile —
so there is no migration. But `npm run verify:embed` must pass, and the artifact
round-trip should be re-run explicitly rather than assumed: a plan whose pass
order changed is exactly the sort of thing a codec with an index assumption would
mishandle.

## What this plan deliberately does NOT do

- **No change to partitioning, relay grouping, or pass contents.** Permutation
  and index remap only.
- **No preview-renderer change.** At 80×80 the memory does not matter, and the
  same reasoning that kept one-texture-per-pass there still holds.
- **No general memory win.** Says so twice, on purpose.
