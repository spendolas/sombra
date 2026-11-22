/**
 * What a wire into a parameter delivers, when the editor can say exactly.
 *
 * Step one of the Wired Param Row plug-in plan (.figma/wiki/molecules/wired-param-row.md):
 * only DIRECT constant sources resolve — a Number node, a Color node, or a Random
 * node whose min/max/decimals are not themselves wired. Everything else (chains,
 * Time, per-pixel sources) returns null and keeps the plain "← Source" display;
 * claiming a value we cannot compute would be worse than showing none.
 */

import { hashNodeId } from '@/nodes/input/random'

export type WiredRgbaValue = [number, number, number, number]

export type ResolvedConstant =
  | { kind: 'float'; value: number }
  | { kind: 'color'; value: WiredRgbaValue }

interface SourceNodeLike {
  id: string
  data: { type: string; params?: Record<string, unknown> }
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Random's value on the CPU, matching random.ts exactly: `min + fract(seed + hash) * (max - min)`,
 * the hash truncated to 6 decimals as both shader generators bake it, rounded to `decimals`.
 */
export function randomValue(nodeId: string, params: Record<string, unknown>): number {
  const min = num(params.min, 0)
  const max = num(params.max, 1)
  const seed = num(params.seed, 0)
  const dpRaw = Math.round(num(params.decimals, 7))
  const dp = Math.min(100, Math.max(0, dpRaw))
  const hash = Number(hashNodeId(nodeId).toFixed(6))
  const step = Math.pow(10, -dp)
  const raw = min + ((((seed + hash) % 1) + 1) % 1) * (max - min)
  return Math.round(raw / step) * step
}

/**
 * Resolve a source node's output when it is a constant. `wiredParamIds` is the set of the
 * source node's own params that are wire-driven: a Random with a wired min/max is not constant.
 */
export function resolveConstantSource(
  source: SourceNodeLike,
  wiredParamIds: ReadonlySet<string>,
): ResolvedConstant | null {
  const p = source.data.params ?? {}
  switch (source.data.type) {
    case 'float_constant':
      return { kind: 'float', value: num(p.value, 1) }
    case 'color_constant': {
      const c = Array.isArray(p.color) ? (p.color as unknown[]) : [1, 0, 1, 1]
      return { kind: 'color', value: [num(c[0], 0), num(c[1], 0), num(c[2], 0), num(c[3], 1)] }
    }
    case 'random':
      if (wiredParamIds.has('min') || wiredParamIds.has('max') || wiredParamIds.has('decimals')) return null
      return { kind: 'float', value: randomValue(source.id, p) }
    default:
      return null
  }
}

/** Number formatting for a param row: as many decimals as its step needs, at least two. */
export function formatterForStep(step: number | undefined): (v: number) => string {
  const s = step && step > 0 ? step : 0.01
  const d = s >= 1 ? 0 : Math.min(4, Math.max(2, Math.ceil(-Math.log10(s) - 1e-9)))
  return (v) => v.toFixed(d)
}
