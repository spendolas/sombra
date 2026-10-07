let orderingEnabled = true

/**
 * VERIFICATION ONLY. Lets scripts/verify-pass-order.ts compile the same graph
 * with and without the permutation to measure what it changed. Nothing in the
 * app calls this; the compiler worker always runs with ordering on.
 */
export function setPassOrderingEnabled(on: boolean): void {
  orderingEnabled = on
}

/**
 * Reorder a finished plan so each pass sits close to the pass that consumes it.
 *
 * partitionPasses groups by DEPTH, so a Stack's N layer sources are emitted as
 * one primary plus N-1 relays before any compositing begins — and layer 15's
 * texture is then alive from pass 15 to pass 31. A pass that reads nothing can
 * legally sit anywhere before its consumer, so the fix is a permutation of the
 * finished pass array plus an index remap, not a change to partitioning. Run it
 * BEFORE assignTextureSlots (texture-slots.ts): liveness is what turns the
 * shorter lifetimes into fewer textures.
 *
 * Pure and generic: the two backends describe reads differently (a Record on
 * the GLSL path, an Array on the IR path), and supplying `readsOf`/`remap` per
 * backend is what keeps one implementation — and one ordering — for both.
 *
 * Not a general memory optimisation. Real saved graphs are already close to
 * consumer-ordered; this is what makes a deep Stack scale.
 */
export function orderPassesByConsumer<T>(
  passes: T[],
  readsOf: (p: T) => number[],
  remap: (p: T, oldToNew: number[]) => T,
): T[] {
  const n = passes.length
  if (!orderingEnabled || n <= 2) return passes

  const reads = passes.map(readsOf)
  // firstConsumer[i] = earliest (original) pass that reads i, or Infinity.
  const firstConsumer = new Array<number>(n).fill(Infinity)
  reads.forEach((srcs, i) => {
    for (const s of srcs) if (s >= 0 && s < n) firstConsumer[s] = Math.min(firstConsumer[s], i)
  })

  // The output pass renders to the canvas and must stay last.
  const last = n - 1
  const scheduled: number[] = []
  const done = new Array<boolean>(n).fill(false)
  const ready = (i: number) => reads[i].every((s) => s >= 0 && s < n && done[s])
  // remaining[s] = readers of s not yet scheduled. delta(i) = change in live
  // textures if i runs next: +1 for its own target, -1 per input it frees.
  const remaining = new Array<number>(n).fill(0)
  reads.forEach((srcs) => { for (const s of new Set(srcs)) if (s >= 0 && s < n) remaining[s]++ })
  const delta = (i: number) => {
    let freed = 0
    for (const s of new Set(reads[i])) if (remaining[s] === 1) freed++
    return (remaining[i] > 0 ? 1 : 0) - freed
  }

  while (scheduled.length < n - 1) {
    // Among the ready passes, prefer:
    //  1. the one that grows live memory least (delta). In a chain, composite
    //     k frees its inputs and source k+1 does not, so the composite runs
    //     first — 3 slots, not 4. It also untangles the merged multi-node
    //     passes a nested stack produces (exhaustively optimal on every gate
    //     shape — scripts/verify-pass-order.ts).
    //  2. then the one whose consumer comes soonest — what keeps a source next
    //     to its reader instead of at the front of the plan.
    //  3. then the later pass.
    let pick = -1
    for (let i = 0; i < last; i++) {
      if (done[i] || !ready(i)) continue
      if (pick === -1) { pick = i; continue }
      const d = delta(i) - delta(pick)
      if (d < 0 || (d === 0 && firstConsumer[i] <= firstConsumer[pick])) pick = i
    }
    if (pick === -1) break // cycle or out-of-range read: fall back below
    scheduled.push(pick)
    done[pick] = true
    for (const s of new Set(reads[pick])) remaining[s]--
  }

  // Deliberate fallback: if the ready set empties early, return the ORIGINAL
  // order untouched rather than a partial reorder. An un-optimised plan is a
  // performance outcome; a plan whose passes are out of order is a wrong image.
  if (scheduled.length < n - 1) return passes
  scheduled.push(last)

  const oldToNew = new Array<number>(n).fill(-1)
  scheduled.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx })
  return scheduled.map((oldIdx) => remap(passes[oldIdx], oldToNew))
}
