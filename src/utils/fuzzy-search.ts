/**
 * Lightweight fuzzy search scorer for node definitions.
 * No external dependencies — ~39 items doesn't need fuse.js.
 */

import type { NodeDefinition } from '../nodes/types'

export interface SearchResult {
  definition: NodeDefinition
  score: number       // 0 = perfect, higher = worse
  matchField: string  // 'label' | 'category' | 'description'
}

/**
 * Fuzzy match: iterate query chars, find each sequentially in text.
 * Returns score (lower = better) or null (no match).
 * Score penalizes gaps between matched chars.
 */
function fuzzyMatch(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  let qi = 0
  let ti = 0
  let score = 0
  let lastMatchIndex = -1

  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      // Penalize gaps between consecutive matched chars
      if (lastMatchIndex >= 0) {
        const gap = ti - lastMatchIndex - 1
        score += gap
      }
      // Bonus for matching at word start
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '-' || t[ti - 1] === '_') {
        score -= 0.5
      }
      lastMatchIndex = ti
      qi++
    }
    ti++
  }

  // All query chars must be found
  if (qi < q.length) return null

  return Math.max(0, score)
}

/**
 * Search nodes by fuzzy-matching query against label, category, and description.
 * Label matches are weighted best (1x), category (1.5x), description (2x).
 * Results are sorted by score and grouped by category for display.
 */
/** Max score for a label subsequence to count — beyond this the match is too scattered to be useful. */
const LABEL_MAX_SCORE = 2.5

export function searchNodes(query: string, nodes: NodeDefinition[]): SearchResult[] {
  if (!query.trim()) {
    // No query — return all nodes (no scoring needed)
    return nodes.map(n => ({ definition: n, score: 0, matchField: 'label' }))
  }

  const results: SearchResult[] = []
  const q = query.trim().toLowerCase()

  for (const node of nodes) {

    let bestScore = Infinity
    let bestField = 'label'

    // Cap label matches so only reasonably tight subsequences count — a very
    // scattered match (e.g. "str" spread across "HSV to Rgb") is noise, not a hit.
    const labelScore = fuzzyMatch(query, node.label)
    if (labelScore !== null && labelScore <= LABEL_MAX_SCORE && labelScore < bestScore) {
      bestScore = labelScore
      bestField = 'label'
    }

    // Category is a single word — contiguous substring (not subsequence) so
    // e.g. "str" doesn't spuriously match "Di[s][t]o[r]t" and pull in every
    // distort node.
    const catIdx = node.category.toLowerCase().indexOf(q)
    if (catIdx >= 0) {
      const weighted = 1.5 + catIdx * 0.02
      if (weighted < bestScore) {
        bestScore = weighted
        bestField = 'category'
      }
    }

    if (node.description) {
      // Descriptions are full sentences, so a loose subsequence match (as used
      // for labels) finds a short query like "str" in nearly every one
      // ("Re[s][t]ric[t]"…) and the palette matches everything. Require the
      // query as a CONTIGUOUS substring here instead — a real relevance signal.
      const idx = node.description.toLowerCase().indexOf(q)
      if (idx >= 0) {
        // Earlier occurrence slightly better; always ranked behind label/category.
        const weighted = 2 + idx * 0.02
        if (weighted < bestScore) {
          bestScore = weighted
          bestField = 'description'
        }
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
 * Categories are ordered by the best score of any item in that category.
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
