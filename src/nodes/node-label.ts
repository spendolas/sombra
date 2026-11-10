/**
 * Author-given node names (`NodeData.label`).
 *
 * A custom label is what an embed host binds to: the manifest derives knob keys
 * from it (`site.balance` → `site-balance-value`, see src/embed/manifest.ts).
 * Every writer (the store's renameNode, the compact share hash) and every
 * reader that turns a label into a key goes through this one normaliser, so a
 * label means the same thing wherever it was set or read.
 */

/** Longest custom label kept. Longer input is cut, not rejected. */
export const NODE_LABEL_MAX = 40

/**
 * The stored form of a custom label: trimmed and capped at NODE_LABEL_MAX
 * characters. `undefined` means "no custom label" — the node shows its type
 * label — and is what an empty, whitespace-only or non-string input becomes.
 */
export function normalizeNodeLabel(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined
  const clipped = label.trim().slice(0, NODE_LABEL_MAX).trim()
  return clipped.length > 0 ? clipped : undefined
}
