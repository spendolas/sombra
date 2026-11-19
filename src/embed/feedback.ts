/**
 * Player feedback: what the player says back when it is asked for something it can't do.
 *
 * Conventions (the usual ones for an API embedded in a page you don't control):
 *  - NEVER throw from a setter: hosts call set() inside their own animation loops, and
 *    one exception would kill their render loop. Report and carry on.
 *  - Say it once. A slider driving set() at 60 Hz must not flood the console, so each
 *    distinct problem (code + key) is reported once.
 *  - Give the caller something it can act on: set() returns true/false, and every
 *    report has a stable `code` and is also delivered as a 'warning' event.
 *  - Be specific and offer a way out: "did you mean ...", what was expected, what was got.
 *  - Feature-detect, don't sniff versions: `capabilities` lists what THIS build can do,
 *    so a page can check before calling instead of hitting "x is not a function".
 *  - Don't change behaviour while reporting: values outside the editor's slider range are
 *    flagged but still applied.
 *
 * Player half of the embed bundle: imports nothing but types.
 */
import type { KnobDescriptor } from './artifact'

export type WarningCode = 'UNKNOWN_KNOB' | 'BAD_VALUE' | 'OUT_OF_RANGE' | 'UNKNOWN_EVENT'

/** A non-fatal problem with a call the host page made. Delivered via `on('warning')`. */
export interface SombraWarning {
  code: WarningCode
  message: string
  /** The knob key / event name the report is about. */
  key?: string
  /** A suggestion, e.g. 'Did you mean "noise-scale"?'. */
  hint?: string
}

/** What this player build can do. Feature-detect with `handle.capabilities` or
 *  `Sombra.supports(name)`. Names are stable; new ones are only ever added. */
export const CAPABILITIES: readonly string[] = [
  'knobs',               // set / get / variables
  'knobs.byNode',        // set(nodeId, param, v) / get(nodeId, param) / nodes()
  'clock.play',          // play / pause / isPlaying
  'clock.time',          // getTime / setTime
  'clock.timeScale',     // getTimeScale / setTimeScale
  'events.load',
  'events.error',
  'events.contextlost',
  'events.warning',      // on('warning', cb): non-fatal API misuse, with a code
  'set.returnsBoolean',  // set() returns true when applied, false when not
  'capabilities',
]

export function supports(name: string): boolean {
  return CAPABILITIES.includes(name)
}

/** Report each distinct problem once (console.warn + the 'warning' event). Bounded, so a
 *  host passing endless random keys can't grow it without limit. */
export function createReporter(emit: (w: SombraWarning) => void, max = 200): (w: SombraWarning) => void {
  const seen = new Set<string>()
  return (w) => {
    // Different mistakes on the same knob each deserve one report (NaN, then a string, then
    // an array), so the message is part of the identity. OUT_OF_RANGE quotes the value, which
    // changes on every call, so it is once per knob only.
    const id = w.code === 'OUT_OF_RANGE' ? `${w.code}|${w.key ?? ''}` : `${w.code}|${w.key ?? ''}|${w.message}`
    if (seen.has(id) || seen.size >= max) return
    seen.add(id)
    console.warn(`[Sombra] ${w.code}: ${w.message}${w.hint ? ' ' + w.hint : ''}`)
    try { emit(w) } catch { /* a throwing host listener must not break the player */ }
  }
}

/** Levenshtein distance, early-out above `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** The candidate closest to `key` (case-insensitive), or undefined if nothing is near. */
export function closest(key: string, candidates: Iterable<string>): string | undefined {
  const k = key.toLowerCase()
  const limit = Math.max(2, Math.floor(k.length / 3))
  let best: string | undefined
  let bestD = limit + 1
  for (const c of candidates) {
    const d = distance(k, c.toLowerCase(), limit)
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Stable wording (never quotes a varying number), so identical mistakes dedupe. */
export const describe = (v: unknown): string =>
  Array.isArray(v) ? `an array of length ${v.length}`
  : v === null ? 'null'
  : typeof v === 'number' ? (Number.isNaN(v) ? 'NaN' : !Number.isFinite(v) ? (v > 0 ? 'Infinity' : '-Infinity') : v < 0 ? 'a negative number' : 'a number')
  : (typeof v === 'object' ? 'an object' : `a ${typeof v}`)

export type ValueCheck =
  | { ok: true; value: number | number[]; outOfRange?: string }
  | { ok: false; message: string }

/** Check a value against a knob's declared type. Never changes a valid value. */
export function checkKnobValue(
  knob: Pick<KnobDescriptor, 'glslType' | 'min' | 'max'>,
  value: unknown,
): ValueCheck {
  const t = knob.glslType
  if (t === 'float') {
    if (!isNum(value)) return { ok: false, message: `expected a finite number, got ${describe(value)}.` }
    const lo = knob.min, hi = knob.max
    if ((lo !== undefined && value < lo) || (hi !== undefined && value > hi)) {
      return { ok: true, value, outOfRange: `value ${value} is outside the editor range ${lo ?? '-inf'}..${hi ?? 'inf'}; applied anyway.` }
    }
    return { ok: true, value }
  }
  const lengths = t === 'vec2' ? [2] : t === 'vec3' ? [3] : [3, 4] // vec4 / colour accepts rgb or rgba
  if (!Array.isArray(value) || !lengths.includes(value.length) || !value.every(isNum)) {
    return { ok: false, message: `expected an array of ${lengths.join(' or ')} finite numbers, got ${describe(value)}.` }
  }
  return { ok: true, value: value as number[] }
}
