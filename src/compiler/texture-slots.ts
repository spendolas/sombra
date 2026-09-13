/**
 * Which physical texture each pass renders into.
 *
 * Renderers index intermediates by pass number, so an N-pass plan holds N
 * full-canvas textures alive for the life of the plan. Most are dead long
 * before that: a slot is only needed until the LAST pass that reads it has run.
 *
 * Not ping-pong. Two-texture alternation assumes each pass reads the one before
 * it, which relay passes violate — that bug is why one-texture-per-pass exists
 * today (21d4477). Liveness handles a non-adjacent read by construction,
 * because the source stays alive until its final reader.
 *
 * Passes of different target sizes never share a slot: `sizeKey` buckets them.
 */
export interface PassLiveness {
  index: number
  /** Pass indices whose OUTPUT this pass samples. */
  readsPassIndices: number[]
  /** Passes sharing a key have identical target dimensions. */
  sizeKey: string
}

export function assignTextureSlots(
  passes: PassLiveness[],
): { slotOfPass: number[]; slotCount: number } {
  // lastReader[i] = the highest pass index that reads pass i's output.
  // -1 means nothing reads it (the final pass, which renders to the canvas).
  const lastReader = new Array<number>(passes.length).fill(-1)
  for (const p of passes) {
    for (const src of p.readsPassIndices) {
      if (src >= 0 && src < passes.length) {
        lastReader[src] = Math.max(lastReader[src], p.index)
      }
    }
  }

  const slotOfPass = new Array<number>(passes.length).fill(-1)
  const slotSizeKey: string[] = []
  // Which pass currently owns each slot, so we know when it frees.
  const slotOwner: number[] = []

  for (const p of passes) {
    // Free every slot whose owner has no reader left after this point.
    for (let s = 0; s < slotOwner.length; s++) {
      const owner = slotOwner[s]
      if (owner >= 0 && lastReader[owner] < p.index) slotOwner[s] = -1
    }

    // A pass nothing reads needs no intermediate at all.
    if (lastReader[p.index] === -1) continue

    // Reuse a free slot of the right size, else open a new one.
    let slot = slotOwner.findIndex((o, s) => o === -1 && slotSizeKey[s] === p.sizeKey)
    if (slot === -1) {
      slot = slotOwner.length
      slotOwner.push(-1)
      slotSizeKey.push(p.sizeKey)
    }
    slotOwner[slot] = p.index
    slotOfPass[p.index] = slot
  }

  return { slotOfPass, slotCount: slotOwner.length }
}
