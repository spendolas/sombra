/**
 * Colour-ramp stops — the ONE reader of `params.stops`, shared by Color Ramp
 * (color-ramp.ts), Gradient (pattern/gradient.ts) and the ramp editor
 * (components/ColorRampEditor.tsx), so all three see the same stops with the
 * same ids.
 *
 * Each stop's colour is a runtime uniform (one hidden `color` param per stop,
 * see stopColorParams); positions and the interpolation mode stay compile-time.
 * That makes every stop an embed knob (`<node>-stop-<n>`) a host can set at
 * 60 Hz, alpha included, while `params.stops` stays the single source of truth
 * in the editor.
 *
 * Stop ids are stable and never reused, exactly like Stack layer ids
 * (stack.ts): they become uniform-name fragments, so they are alphanumeric and
 * unique within the node. Files saved before stops had ids resolve
 * deterministically by STORED array index (`s0`, `s1`, …), so an old file maps
 * to the same uniforms on every load.
 */
import type { NodeParameter } from '../types'

export type Rgba = [number, number, number, number]

/** A stop as stored in `params.stops`. `id` is absent in files saved before stop ids. */
export interface ColorStop {
  id?: string
  position: number
  /** RGB (legacy, alpha defaults to 1) or RGBA. */
  color: [number, number, number] | Rgba
}

/** A stop as codegen and the editor see it: always an id, always RGBA. */
export interface RampStop {
  id: string
  position: number
  color: Rgba
}

/** Ids become GLSL/WGSL identifier fragments (uniform names), so stay alnum. */
const ID_RE = /^[A-Za-z0-9]+$/

/** What a missing or unusable stop list renders as: black → white. */
export const DEFAULT_RAMP_STOPS: readonly RampStop[] = [
  { id: 's0', position: 0, color: [0, 0, 0, 1] },
  { id: 's1', position: 1, color: [1, 1, 1, 1] },
]

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * RGBA from a stored colour: a 4-tuple as is, anything else as its RGB with
 * alpha 1 — the exact rule codegen has always used for legacy 3-tuples.
 */
function toRgba(color: unknown): Rgba | null {
  if (!Array.isArray(color) || color.length < 3) return null
  if (!isNum(color[0]) || !isNum(color[1]) || !isNum(color[2])) return null
  if (color.length === 4) return isNum(color[3]) ? [color[0], color[1], color[2], color[3]] : null
  return [color[0], color[1], color[2], 1]
}

/**
 * The node's stops in STORED order, every one with an id and an RGBA colour.
 * Unusable entries are dropped; fewer than two usable stops (or a missing /
 * non-array value) falls back to DEFAULT_RAMP_STOPS, as codegen always has.
 *
 * Id resolution is a pure function of the stored array: an entry keeps its own
 * id when it is alphanumeric and not already taken by an earlier entry;
 * otherwise it gets `s<stored index>` (with a deterministic suffix in the
 * unlikely case another entry already owns that id).
 */
export function normalizeStops(raw: unknown): RampStop[] {
  if (!Array.isArray(raw)) return DEFAULT_RAMP_STOPS.map(cloneStop)
  const parsed: Array<{ index: number; id?: string; position: number; color: Rgba }> = []
  const taken = new Set<string>()
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const s = item as Record<string, unknown>
    const color = toRgba(s.color)
    if (!isNum(s.position) || !color) return
    const own = typeof s.id === 'string' && ID_RE.test(s.id) && !taken.has(s.id) ? s.id : undefined
    if (own) taken.add(own)
    parsed.push({ index, id: own, position: s.position, color })
  })
  if (parsed.length < 2) return DEFAULT_RAMP_STOPS.map(cloneStop)
  return parsed.map((p) => {
    if (p.id) return { id: p.id, position: p.position, color: p.color }
    let id = `s${p.index}`
    for (let k = 2; taken.has(id); k++) id = `s${p.index}x${k}`
    taken.add(id)
    return { id, position: p.position, color: p.color }
  })
}

function cloneStop(s: RampStop): RampStop {
  return { id: s.id, position: s.position, color: [...s.color] as Rgba }
}

/** Ascending by position; equal positions keep stored order (Array.sort is stable). */
export function sortStops<T extends { position: number }>(stops: readonly T[]): T[] {
  return [...stops].sort((a, b) => a.position - b.position)
}

/** The hidden uniform param that carries one stop's colour. */
export const stopParamId = (id: string) => `stop_${id}`

/**
 * One hidden `color` uniform param per stop, in ascending position order — the
 * `dynamicParams` of both ramp nodes (appended after their static params). The
 * default IS the stop's colour, and nothing writes these ids into
 * `node.data.params`, so `params.stops` stays the only stored copy. `label`
 * and `knobMeta` are what the embed manifest publishes (`<node>-stop-<n>`).
 */
export function stopColorParams(params: Record<string, unknown>): NodeParameter[] {
  return sortStops(normalizeStops(params.stops)).map((s, n): NodeParameter => ({
    id: stopParamId(s.id),
    label: `Stop ${n}`,
    type: 'color',
    default: [...s.color] as Rgba,
    hidden: true,
    updateMode: 'uniform',
    knobMeta: { group: 'stops', index: n, position: s.position },
  }))
}

/**
 * The uniform a stop's colour is read from. The compilers resolve every
 * dynamic param into `inputs` before calling glsl()/ir(); a missing entry means
 * the param set and the codegen disagree, which must fail loudly rather than
 * bake a stale or default colour.
 */
export function stopUniform(inputs: Record<string, string>, stop: RampStop, nodeType: string): string {
  const name = inputs[stopParamId(stop.id)]
  if (!name) throw new Error(`${nodeType}: no uniform resolved for stop "${stop.id}"`)
  return name
}

/** A fresh stop id: alphanumeric (it becomes part of uniform names), unused on this node. */
export function newStopId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = `s${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`
    if (!taken.has(id)) return id
  }
}
