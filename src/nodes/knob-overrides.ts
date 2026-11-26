/**
 * Per-knob author overrides (`NodeData.knobs`): a custom name and a hide flag
 * for each embed knob, keyed by the param id that owns it.
 *
 * Set from the Embed modal's knob table. Like a custom node label
 * (node-label.ts), an override is publishing metadata, not shader content: it is
 * in no compile / uniform / renderer key, is one undo step, and is kept in
 * `.sombra` files, localStorage and compact share links.
 *
 *  - `name` replaces the param's own label for this knob. It sets the second
 *    half of the published key: renaming Balance's "Value" to "Amount" publishes
 *    `site-balance-amount` instead of `site-balance-value`. Normalised exactly
 *    like a node label (trimmed, silently capped); empty means "use the label".
 *  - `hidden: true` leaves the knob out of the published manifest. Its uniform
 *    keeps the value it has in the editor; a host can no longer read or set it.
 *
 * Every reader and writer goes through normalizeKnobOverrides, so a stored value
 * from any source (file, share link, older build) means the same thing.
 */

import { normalizeNodeLabel } from './node-label'

export interface KnobOverride {
  /** Custom knob name; absent = the param's own label. */
  name?: string
  /** Leave this knob out of the published embed. Only ever stored as `true`. */
  hidden?: true
}

/** paramId → override. Absent (not `{}`) when a node has none. */
export type KnobOverrides = Record<string, KnobOverride>

/** Same rule as a node label: trimmed, capped, `undefined` for empty / non-string. */
export const normalizeKnobName = normalizeNodeLabel

function normalizeOne(v: unknown): KnobOverride | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const name = normalizeKnobName(o.name)
  const out: KnobOverride = {}
  if (name !== undefined) out.name = name
  if (o.hidden === true) out.hidden = true
  return out.name !== undefined || out.hidden ? out : undefined
}

/**
 * The stored form: only params with a real override, only meaningful fields,
 * `undefined` when nothing is left. Safe on any input (decoded files are untrusted).
 */
export function normalizeKnobOverrides(v: unknown): KnobOverrides | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: KnobOverrides = {}
  for (const [paramId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (paramId === '__proto__' || paramId === 'constructor' || paramId === 'prototype') continue
    const o = normalizeOne(raw)
    if (o) out[paramId] = o
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The override for one knob ({} when none). */
export function knobOverride(knobs: unknown, paramId: string): KnobOverride {
  return normalizeKnobOverrides(knobs)?.[paramId] ?? {}
}

/** A change to one knob: `name: undefined | ''` clears the name; `hidden: false` clears the flag. */
export interface KnobOverridePatch {
  name?: string | undefined
  hidden?: boolean
}

/**
 * Apply a patch and return the new normalised map (`undefined` = none left).
 * Fields not present in the patch are kept.
 */
export function applyKnobOverride(knobs: unknown, paramId: string, patch: KnobOverridePatch): KnobOverrides | undefined {
  const all: Record<string, unknown> = { ...(normalizeKnobOverrides(knobs) ?? {}) }
  const cur = { ...((all[paramId] as KnobOverride | undefined) ?? {}) } as Record<string, unknown>
  if ('name' in patch) cur.name = patch.name
  if ('hidden' in patch) cur.hidden = patch.hidden === true ? true : undefined
  all[paramId] = cur
  return normalizeKnobOverrides(all)
}
