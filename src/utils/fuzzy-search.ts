/**
 * Match ranking for the Cmd+K node palette (~41 items — no fuse.js needed).
 *
 * Follows the standard fuzzy-matcher quality order used by fzf / Sublime /
 * VS Code quick-open, from best to worst:
 *
 *   exact  >  prefix  >  word-boundary substring  >  mid-word substring  >  subsequence
 *
 * and — critically — the FIELD a query hits matters more than the match
 * quality within it: a hit on the node's label always outranks a hit on its
 * description. That's encoded with large per-field weights so the bands never
 * overlap. Lower score = better.
 */

import type { NodeDefinition } from '../nodes/types'

export interface SearchResult {
  definition: NodeDefinition
  score: number       // 0 = perfect; higher = worse
  matchField: string  // 'label' | 'category' | 'description'
}

// Field bands are 10 apart so any label match beats any category match, which
// beats any description match — regardless of within-field quality.
const FIELD_WEIGHT: Record<string, number> = { label: 0, category: 10, description: 20 }

// Reject a subsequence match once its chars are too scattered to be meaningful
// (e.g. "str" spread across "H[s]v [t]o [r]gb") — those are noise, not intent.
const MAX_SUBSEQ_GAP = 2

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === ' ' || ch === '-' || ch === '_' || ch === '/'
}

/**
 * Total gap between sequentially-matched query chars (0 = contiguous), or null
 * if `q` is not a subsequence of `t` at all.
 */
function subsequenceGap(q: string, t: string): number | null {
  let qi = 0
  let ti = 0
  let gap = 0
  let last = -1
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      if (last >= 0) gap += ti - last - 1
      last = ti
      qi++
    }
    ti++
  }
  if (qi < q.length) return null
  return gap
}

/**
 * Quality score (lower = better) for matching `q` within `text`, or null for
 * no match. `q` must already be trimmed + lowercased. `idx * 0.005` is a tiny
 * position tiebreak (earlier occurrence slightly better) that never crosses a
 * quality tier.
 */
function matchQuality(q: string, text: string, allowSubsequence: boolean): number | null {
  const t = text.toLowerCase()
  if (t === q) return 0                                      // exact
  const idx = t.indexOf(q)
  if (idx === 0) return 1                                    // prefix
  if (idx > 0) return (isBoundary(t[idx - 1]) ? 2 : 3) + idx * 0.005  // word-boundary vs mid-word
  // Subsequence (fuzzy) matching is for LABELS only — node names, where typo
  // tolerance is wanted. On categories/descriptions it matches almost anything
  // (e.g. "str" as a subsequence of "Di[s][t]o[r]t" or any sentence).
  if (!allowSubsequence) return null
  const gap = subsequenceGap(q, t)
  if (gap === null || gap > MAX_SUBSEQ_GAP) return null
  return 5 + gap                                             // scattered (but still tight) subsequence
}

/**
 * Search nodes by matching query against label, category, and description.
 * Each node is scored by its BEST field (field weight + within-field quality);
 * results are sorted best-first and grouped by category for display.
 */
export function searchNodes(query: string, nodes: NodeDefinition[]): SearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    // No query — return all nodes (no scoring needed).
    return nodes.map(n => ({ definition: n, score: 0, matchField: 'label' }))
  }

  const results: SearchResult[] = []

  for (const node of nodes) {
    let bestScore = Infinity
    let bestField = 'label'

    // Only labels get subsequence (fuzzy) matching; category/description are substring-only.
    const fields: Array<[string, string | undefined, boolean]> = [
      ['label', node.label, true],
      ['category', node.category, false],
      ['description', node.description, false],
    ]

    for (const [field, text, allowSubsequence] of fields) {
      if (!text) continue
      const quality = matchQuality(q, text, allowSubsequence)
      if (quality === null) continue
      const total = quality + FIELD_WEIGHT[field]
      if (total < bestScore) {
        bestScore = total
        bestField = field
      }
    }

    if (bestScore < Infinity) {
      results.push({ definition: node, score: bestScore, matchField: bestField })
    }
  }

  return results.sort((a, b) => a.score - b.score)
}

/**
 * Group search results by category, preserving score order within groups.
 * Categories appear in the order their best-scoring item does.
 */
export function groupByCategory(results: SearchResult[]): Map<string, SearchResult[]> {
  const groups = new Map<string, SearchResult[]>()
  for (const r of results) {
    const cat = r.definition.category
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(r)
  }
  return groups
}
