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
 * Build the public knob list from the compiler's uniform specs joined with each
 * param's static NodeDefinition metadata. Keys are slugified labels, deduped
 * with -2/-3 suffixes. Call after initializeNodeLibrary().
 */
export function buildManifest(
  uniforms: UniformSpec[],
  nodes: Node<NodeData>[],
): KnobDescriptor[] {
  const nodeType = new Map(nodes.map((n) => [n.id, n.data.type]))
  const usedKeys = new Map<string, number>()
  const out: KnobDescriptor[] = []

  for (const u of uniforms) {
    const type = nodeType.get(u.nodeId)
    const def = type ? nodeRegistry.get(type) : undefined
    const param = def?.params?.find((p) => p.id === u.paramId)
    if (!param) continue // no metadata → skip (defensive)

    let key = slugify(param.label) || u.paramId
    const n = usedKeys.get(key) ?? 0
    usedKeys.set(key, n + 1)
    if (n > 0) key = `${key}-${n + 1}`

    out.push({
      key,
      uniform: u.name,
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
