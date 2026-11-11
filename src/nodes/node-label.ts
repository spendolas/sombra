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
