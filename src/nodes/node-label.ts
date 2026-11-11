/**
 * Author-given node names (`NodeData.label`).
 *
 * A custom label is what an embed host binds to: the manifest derives knob keys
 * from it (`site.balance` → `site-balance-value`, see src/embed/manifest.ts).
 * Every writer (the store's renameNode, the compact share hash) and every
 * reader that turns a label into a key goes through this one normaliser, so a
 * label means the same thing wherever it was set or read.
 */

/**
 * Silent safety cap, not a design limit: longer input is cut, never rejected,
 * and no UI counts toward it (owner decision 2026-11-10; was 40).
 */
export const NODE_LABEL_MAX = 120

/**
 * The stored form of a custom label: trimmed and silently capped at NODE_LABEL_MAX
 * (120) characters. `undefined` means "no custom label" — the node shows its type
 * label — and is what an empty, whitespace-only or non-string input becomes.
 */
export function normalizeNodeLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined
  const clipped = label.trim().slice(0, NODE_LABEL_MAX).trim()
  return clipped.length > 0 ? clipped : undefined
}

/**
 * The slug a custom label occupies in embed knob keys — the SAME rule as
 * `slugify` / `nameSlug` in src/embed/manifest.ts ('' → 'node'). Two labels
 * with the same slug are the clash the manifest numbers (" 2", " 3"), so this
 * is what the node title's duplicate warning groups by. Kept as a copy because
 * manifest.ts does not export its helper; `verify:node-sections` asserts the
 * two agree on the cases that matter (case, punctuation, spacing).
 */
export function labelSlug(label: string): string {
  const slug = label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'node'
}

const duplicateCache = new WeakMap<readonly { data: { label?: unknown } }[], ReadonlySet<string>>()

/**
 * Slugs carried by more than one custom-labelled node. Computed once per nodes
 * array (the store replaces the array on every graph change, so the cache is
 * exactly "once per graph change"), then shared by every node's title.
 */
export function duplicateLabelSlugs(nodes: readonly { data: { label?: unknown } }[]): ReadonlySet<string> {
  const hit = duplicateCache.get(nodes)
  if (hit) return hit
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const n of nodes) {
    const label = normalizeNodeLabel(n.data.label)
    if (label === undefined) continue
    const slug = labelSlug(label)
    if (seen.has(slug)) dup.add(slug)
    else seen.add(slug)
  }
  duplicateCache.set(nodes, dup)
  return dup
}

/** Does this node's custom label clash with another node's (same knob-key slug)? */
export function hasDuplicateLabel(nodes: readonly { data: { label?: unknown } }[], label: unknown): boolean {
  const l = normalizeNodeLabel(label)
  return l !== undefined && duplicateLabelSlugs(nodes).has(labelSlug(l))
}
