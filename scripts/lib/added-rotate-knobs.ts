/**
 * The ONE rule for "a manifest from before 2026-11-11 vs today's": Noise, FBM
 * and Warp gained the framework Rotate (they declared scale + translate only),
 * so each such node now publishes one extra knob. Snapshot / compat gates strip
 * exactly those knobs before comparing — and only if each one is the standard
 * Rotate knob sitting right after its own node's Scale knob, one per node that
 * publishes a Scale knob. Anything else (renamed, moved, re-ranged, missing,
 * extra) is reported as a problem, so the strip cannot hide a real change.
 *
 * Used by scripts/verify-manifest.ts (unlabelled snapshot, gate e) and
 * scripts/verify-embed-site.ts (compat check E against 5752aa9).
 */
import type { KnobDescriptor } from '../../src/embed/artifact'

export const ROTATE_ADDED_TYPES: ReadonlySet<string> = new Set(['noise', 'fbm', 'warp'])

export interface RotateStrip<K> {
  /** The manifest with the added rotate knobs removed (order otherwise kept). */
  kept: K[]
  /** Keys of the knobs removed. */
  stripped: string[]
  /** Scale knobs on Noise/FBM/Warp nodes — each must have exactly one rotate after it. */
  expected: number
  /** Human-readable reasons the strip is not clean; empty when it is. */
  problems: string[]
}

export function stripAddedRotateKnobs<K extends Pick<KnobDescriptor, 'key' | 'uniform' | 'nodeId' | 'nodeType' | 'param' | 'label' | 'type' | 'min' | 'max' | 'step' | 'default'>>(
  manifest: K[],
): RotateStrip<K> {
  const kept: K[] = []
  const stripped: string[] = []
  const problems: string[] = []
  let expected = 0
  manifest.forEach((k, i) => {
    if (ROTATE_ADDED_TYPES.has(k.nodeType) && k.param === 'scale') expected++
    if (!(ROTATE_ADDED_TYPES.has(k.nodeType) && k.param === 'rotate')) { kept.push(k); return }
    const prev = manifest[i - 1]
    const ok = !!prev && prev.nodeId === k.nodeId && prev.param === 'scale'
      && k.key === `${prev.key.slice(0, -'scale'.length)}rotate`
      && k.uniform === prev.uniform.replace(/srt_scale$/, 'srt_rotate')
      && k.label === 'Rotate' && k.type === 'float'
      && k.min === -180 && k.max === 180 && k.step === 1 && k.default === 0
    if (!ok) problems.push(`${k.key}: not the standard Rotate knob right after its node's Scale knob`)
    stripped.push(k.key)
  })
  if (stripped.length !== expected) problems.push(`${stripped.length} rotate knobs for ${expected} Noise/FBM/Warp scale knobs — expected exactly one each`)
  return { kept, stripped, expected, problems }
}
