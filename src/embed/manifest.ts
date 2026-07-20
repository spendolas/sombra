import type { Node } from '@xyflow/react'
import type { NodeData, NodeParameter, UniformSpec } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import type { KnobDescriptor } from './artifact'

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

/**
 * Resolve a stable, unique display name per node that owns a knob. Prefers the
 * node's custom label, then the node type's friendly label, then the raw type.
 * Duplicates are disambiguated with " 2", " 3" so two Noise nodes read as
 * "Noise" and "Noise 2" — this is what makes the flat knob list legible.
 */
function buildNodeNames(
  nodeIds: string[],
  nodes: Node<NodeData>[],
): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const usedBase = new Map<string, number>()
  const names = new Map<string, string>()

  for (const id of nodeIds) {
    const node = byId.get(id)
    const type = node?.data.type
    const def = type ? nodeRegistry.get(type) : undefined
    const custom = typeof node?.data.label === 'string' ? node.data.label.trim() : ''
    const base = custom || def?.label || type || 'node'
    const n = usedBase.get(base) ?? 0
    usedBase.set(base, n + 1)
    names.set(id, n > 0 ? `${base} ${n + 1}` : base)
  }
  return names
}

/**
 * Build the public knob list from the compiler's uniform specs joined with each
 * param's static NodeDefinition metadata. Keys are node-scoped (`<node>-<param>`,
 * e.g. "noise-scale", "noise-2-scale") so the host can tell which effect each
 * knob drives — a flat "scale-2" list is unreadable in graphs that reuse nodes.
 * Call after initializeNodeLibrary().
 */
export function buildManifest(
  uniforms: UniformSpec[],
  nodes: Node<NodeData>[],
): KnobDescriptor[] {
  const nodeType = new Map(nodes.map((n) => [n.id, n.data.type]))

  // Only nodes that actually own a knob need a display name, in first-seen order.
  const ownerIds: string[] = []
  const seenOwner = new Set<string>()
  for (const u of uniforms) {
    if (!seenOwner.has(u.nodeId)) { seenOwner.add(u.nodeId); ownerIds.push(u.nodeId) }
  }
  const nodeNames = buildNodeNames(ownerIds, nodes)

  const usedKeys = new Map<string, number>()
  const usedParams = new Map<string, Map<string, number>>()  // nodeId → paramSlug → count
  const seenUniforms = new Set<string>()
  const out: KnobDescriptor[] = []

  for (const u of uniforms) {
    // A node's uniform appears once per pass it's used in (multi-pass graphs),
    // so the same wire name can repeat — collapse to one knob, else the host
    // sees phantom "value-2"/"scale-2" duplicates for a single param.
    if (seenUniforms.has(u.name)) continue
    seenUniforms.add(u.name)

    const type = nodeType.get(u.nodeId)
    const def = type ? nodeRegistry.get(type) : undefined
    const param = def?.params?.find((p) => p.id === u.paramId)
    if (!param) continue // no metadata → skip (defensive)

    const nodeName = nodeNames.get(u.nodeId) ?? 'node'
    const nodeSlug = slugify(nodeName) || 'node'
    const paramSlug = slugify(param.label) || u.paramId

    // Dedup the param WITHIN its node so (nodeId, param) is a unique address:
    // one node can expose two uniform params whose labels slugify identically
    // (e.g. gradient's aspect / aspectUV, both "Aspect"). Without this the
    // player's byNode index collides and one param becomes unaddressable.
    const perNode = usedParams.get(u.nodeId) ?? new Map<string, number>()
    usedParams.set(u.nodeId, perNode)
    const pc = perNode.get(paramSlug) ?? 0
    perNode.set(paramSlug, pc + 1)
    const paramId = pc > 0 ? `${paramSlug}-${pc + 1}` : paramSlug

    // Node names are unique and param is now unique within the node, so the key
    // is unique too; the global counter stays as a belt-and-braces guard.
    let key = `${nodeSlug}-${paramId}`
    const n = usedKeys.get(key) ?? 0
    usedKeys.set(key, n + 1)
    if (n > 0) key = `${key}-${n + 1}`

    out.push({
      key,
      uniform: u.name,
      nodeId: u.nodeId,
      node: nodeName,
      nodeType: type ?? 'node',
      // Friendly slug, unique within its node (matches the key's param suffix) —
      // NOT the raw param id ("scale", not "srt_scale"); "aspect-2" on collision.
      param: paramId,
      label: param.label,
      type: knobType(param.type),
      glslType: u.glslType,
      min: param.min,
      max: param.max,
      step: param.step,
      default: u.value,
    })
  }
  return out
}
