import type { Node } from '@xyflow/react'
import type { NodeData, NodeParameter, UniformSpec } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import type { KnobDescriptor } from './artifact'
import { normalizeNodeLabel } from '../nodes/node-label'
import { resolveParams } from '../nodes/resolve-dynamic'
import { knobOverride } from '../nodes/knob-overrides'

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Map a NodeParameter.type to the knob's public type. Only uniform-mode
 * params reach here, so type is always one of these four. */
function knobType(paramType: NodeParameter['type']): KnobDescriptor['type'] {
  return paramType === 'color' ? 'color'
    : paramType === 'vec2' ? 'vec2'
    : paramType === 'vec3' ? 'vec3'
    : 'float'
}

/** The slug a display name occupies in knob keys ('' → 'node', as in buildManifest). */
const nameSlug = (name: string) => slugify(name) || 'node'

/**
 * Resolve a stable, unique display name per node that owns a knob.
 *
 * Author-named nodes (a custom `data.label`) come FIRST and claim their slug,
 * in graph (nodes-array) order: a node labelled `site.balance` is always
 * "site.balance" → key `site-balance-…`, whatever else is in the graph. Two
 * custom labels that slugify the same are de-duplicated " 2", " 3" in graph
 * order (the Embed modal is meant to warn about that clash).
 *
 * Unlabelled nodes then get the type label ("Noise"), or the raw type, with
 * " 2"/" 3" in uniform order — exactly the rule from before labels existed,
 * except that a name whose slug a custom label already owns is skipped. In a
 * graph with no custom labels nothing is claimed, so names (and therefore the
 * whole manifest) are byte-identical to the pre-label output.
 */
function buildNodeNames(
  nodeIds: string[],
  nodes: Node<NodeData>[],
): { names: Map<string, string>; named: Set<string>; clashes: KnobNameClash[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const owners = new Set(nodeIds)
  const names = new Map<string, string>()
  const named = new Set<string>()
  const clashes: KnobNameClash[] = []

  // Pass 1 — custom labels claim their slug, in graph order.
  const claimed = new Map<string, string>() // slug → the label that claimed it
  for (const node of nodes) {
    if (!owners.has(node.id) || names.has(node.id)) continue
    const custom = normalizeNodeLabel(node.data.label)
    if (custom === undefined) continue
    let name = custom
    for (let k = 2; claimed.has(nameSlug(name)); k++) name = `${custom} ${k}`
    if (name !== custom) clashes.push({ nodeId: node.id, label: custom, heldBy: claimed.get(nameSlug(custom))!, name })
    claimed.set(nameSlug(name), custom)
    names.set(node.id, name)
    named.add(node.id)
  }

  // Pass 2 — everyone else, numbered around the claimed slugs.
  const usedBase = new Map<string, number>()
  for (const id of nodeIds) {
    if (names.has(id)) continue
    const node = byId.get(id)
    const type = node?.data.type
    const def = type ? nodeRegistry.get(type) : undefined
    const base = def?.label || type || 'node'
    let n = usedBase.get(base) ?? 0
    let name = n > 0 ? `${base} ${n + 1}` : base
    while (claimed.has(nameSlug(name))) { n++; name = `${base} ${n + 1}` }
    usedBase.set(base, n + 1)
    names.set(id, name)
  }
  return { names, named, clashes }
}

/**
 * A custom node label that had to be numbered because an earlier labelled node
 * (graph order) already holds its slug — so this node's keys are NOT the ones
 * its author typed. Editor-only: never part of the published manifest.
 */
export interface KnobNameClash {
  /** The numbered node. Its knobs are the manifest entries with this nodeId. */
  nodeId: string
  /** The label the author gave it (normalised), e.g. "site.balance". */
  label: string
  /** The label of the node that kept the slug — equal to `label`, or a label that slugs the same. */
  heldBy: string
  /** The name it publishes under instead, e.g. "site.balance 2". */
  name: string
}

/**
 * Build the public knob list from the compiler's uniform specs joined with each
 * param's NodeDefinition metadata, resolved per instance (resolveParams). Keys are node-scoped (`<node>-<param>`,
 * e.g. "noise-scale", "noise-2-scale") so the host can tell which effect each
 * knob drives — a flat "scale-2" list is unreadable in graphs that reuse nodes.
 * Call after initializeNodeLibrary().
 */
export function buildManifest(
  uniforms: UniformSpec[],
  nodes: Node<NodeData>[],
): KnobDescriptor[] {
  return buildManifestWithClashes(uniforms, nodes).manifest
}

/**
 * One knob as the Embed modal's table shows it: published or hidden, with the
 * address the author edits it by (node id + param id). Editor-only: never in the
 * artifact.
 */
export interface KnobEntry {
  /** The descriptor. Hidden knobs get one too (same key rules), so their key is stable. */
  knob: KnobDescriptor
  /** NodeParameter.id — the key of `NodeData.knobs` (setKnobOverride). */
  paramId: string
  /** The param's own label: what an empty name falls back to. */
  defaultName: string
  /** The author renamed this knob (`knob.label` is their name). */
  renamed: boolean
  /** Left out of the published manifest. */
  hidden: boolean
  /** A custom knob name whose slug another knob of the same node already holds, so its key was numbered. */
  nameClash: boolean
}

export interface ManifestBuild {
  /** The published knobs (hidden ones left out) — what goes into the artifact. */
  manifest: KnobDescriptor[]
  /** Labelled nodes numbered by a node-name clash (the modal's notice). */
  clashes: KnobNameClash[]
  /** Every knob, published and hidden, in manifest order (the modal's table). */
  entries: KnobEntry[]
}

/**
 * buildManifest plus what the Embed modal needs beside it: the name clashes its
 * de-dupe pass resolved and every knob including hidden ones. The manifest is the
 * very same array buildManifest returns — the rest never enters the artifact.
 *
 * Per-knob overrides (`NodeData.knobs`, knob-overrides.ts): a custom name
 * replaces the param label in the key and the descriptor's `label`; a hidden
 * knob is computed exactly like a published one (so its key does not move when
 * it is shown again) and then left out of `manifest`.
 */
export function buildManifestWithClashes(
  uniforms: UniformSpec[],
  nodes: Node<NodeData>[],
): ManifestBuild {
  const nodeType = new Map(nodes.map((n) => [n.id, n.data.type]))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  // Only nodes that actually own a knob need a display name, in first-seen order.
  const ownerIds: string[] = []
  const seenOwner = new Set<string>()
  for (const u of uniforms) {
    if (!seenOwner.has(u.nodeId)) { seenOwner.add(u.nodeId); ownerIds.push(u.nodeId) }
  }
  const { names: nodeNames, named, clashes } = buildNodeNames(ownerIds, nodes)

  const usedKeys = new Map<string, number>()
  const usedParams = new Map<string, Map<string, number>>()  // nodeId → paramSlug → count
  const renamedByNode = new Map<string, Set<string>>()        // nodeId → slugs a custom knob name holds
  const seenUniforms = new Set<string>()
  const entries: KnobEntry[] = []

  for (const u of uniforms) {
    // A node's uniform appears once per pass it's used in (multi-pass graphs),
    // so the same wire name can repeat — collapse to one knob, else the host
    // sees phantom "value-2"/"scale-2" duplicates for a single param.
    if (seenUniforms.has(u.name)) continue
    seenUniforms.add(u.name)

    const type = nodeType.get(u.nodeId)
    const def = type ? nodeRegistry.get(type) : undefined
    // Resolve the INSTANCE's params exactly as codegen does: a param that
    // exists only through dynamicParams (a Stack layer's opacity, a ramp
    // stop's colour) emits a uniform, and reading the static def.params here
    // silently dropped its knob.
    const param = def ? resolveParams(def, nodeById.get(u.nodeId)?.data.params).find((p) => p.id === u.paramId) : undefined
    if (!param) continue // no metadata → skip (defensive)

    const nodeName = nodeNames.get(u.nodeId) ?? 'node'
    const nodeSlug = slugify(nodeName) || 'node'
    const override = knobOverride(nodeById.get(u.nodeId)?.data.knobs, u.paramId)
    const label = override.name ?? param.label
    const paramSlug = slugify(label) || u.paramId

    // Dedup the param WITHIN its node so (nodeId, param) is a unique address:
    // one node can expose two uniform params whose labels slugify identically
    // (e.g. gradient's aspect / aspectUV, both "Aspect"). Without this the
    // player's byNode index collides and one param becomes unaddressable.
    const perNode = usedParams.get(u.nodeId) ?? new Map<string, number>()
    usedParams.set(u.nodeId, perNode)
    const pc = perNode.get(paramSlug) ?? 0
    // A rename that collides with another knob of this node (either order) is
    // flagged; two built-in labels that slug the same (aspect / aspectUV) are not.
    const renamedSlugs = renamedByNode.get(u.nodeId) ?? new Set<string>()
    renamedByNode.set(u.nodeId, renamedSlugs)
    const nameClash = pc > 0 && (override.name !== undefined || renamedSlugs.has(paramSlug))
    if (override.name !== undefined) renamedSlugs.add(paramSlug)
    perNode.set(paramSlug, pc + 1)
    const paramId = pc > 0 ? `${paramSlug}-${pc + 1}` : paramSlug

    // Node names are unique and param is now unique within the node, so the key
    // is unique too; the global counter stays as a belt-and-braces guard.
    let key = `${nodeSlug}-${paramId}`
    const n = usedKeys.get(key) ?? 0
    usedKeys.set(key, n + 1)
    if (n > 0) key = `${key}-${n + 1}`

    const knob: KnobDescriptor = {
      key,
      uniform: u.name,
      nodeId: u.nodeId,
      node: nodeName,
      nodeType: type ?? 'node',
      // Friendly slug, unique within its node (matches the key's param suffix) —
      // NOT the raw param id ("scale", not "srt_scale"); "aspect-2" on collision.
      param: paramId,
      label,
      type: knobType(param.type),
      glslType: u.glslType,
      min: param.min,
      max: param.max,
      step: param.step,
      default: u.value,
      // Only when true: an unlabelled scene's manifest stays byte-identical.
      ...(named.has(u.nodeId) ? { named: true } : {}),
      // Ramp stops: group "stops", index, position. Absent for every other knob.
      ...(param.knobMeta ? { ...param.knobMeta } : {}),
    }
    entries.push({
      knob,
      paramId: u.paramId,
      defaultName: param.label,
      renamed: override.name !== undefined,
      hidden: override.hidden === true,
      nameClash,
    })
  }
  return { manifest: entries.filter((e) => !e.hidden).map((e) => e.knob), clashes, entries }
}
