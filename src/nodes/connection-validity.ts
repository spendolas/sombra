/**
 * May this wire be made?
 *
 * Lived inline in FlowCanvas as a `useCallback`, which meant nothing could test
 * it: the only way to ask the question was to render a canvas and drag. It is a
 * pure function of (nodes, edges, candidate), so it is one here, and the canvas
 * calls it.
 *
 * The rule it exists to keep: a target port may come from `inputs`, from
 * `dynamicInputs`, or from a CONNECTABLE PARAM — and a node whose params vary
 * per instance declares them through `dynamicParams`, not `def.params`. Reading
 * the static list refuses those wires, and refuses them silently: React Flow
 * simply declines the drop, so the user sees a wire that will not attach and no
 * reason why. Stack's per-layer opacity and mask are exactly this shape.
 */

import type { NodeData, NodeDefinition, PortType } from './types'
import { resolveParams } from './resolve-dynamic'
import { areTypesCompatible } from './type-coercion'
import { wouldCreateCycle } from '../compiler/topological-sort'

/** The candidate wire, in React Flow's shape (all four may be null mid-drag). */
export interface ConnectionCandidate {
  source?: string | null
  target?: string | null
  sourceHandle?: string | null
  targetHandle?: string | null
}

/** Only the node fields this predicate reads — so a gate need not build a React Flow node. */
export interface ValidityNode {
  id: string
  data: Pick<NodeData, 'type'> & { params?: Record<string, unknown> }
}

/** Only the edge fields this predicate reads. */
export interface ValidityEdge {
  source: string
  target: string
}

/**
 * Every port an instance of this node can be wired INTO: its inputs (dynamic
 * where declared) plus its connectable params (likewise dynamic).
 *
 * Deliberately NOT exported. Its one caller is below, and a gate that vetted
 * its own fixture through this function would report "fixture is broken"
 * instead of "the wire was refused" the moment the lookup regressed — the
 * finding hidden behind a complaint about the test.
 */
function targetPorts(
  def: NodeDefinition,
  nodeParams: Record<string, unknown> | undefined,
): Array<{ id: string; type: PortType }> {
  const inputs = def.dynamicInputs ? def.dynamicInputs(nodeParams ?? {}) : def.inputs
  const connectableParams = resolveParams(def, nodeParams)
    .filter((p) => p.connectable)
    .map((p) => ({ id: p.id, type: p.type as PortType }))
  return [
    ...inputs.map((p) => ({ id: p.id, type: p.type })),
    ...connectableParams,
  ]
}

export function isConnectionValid(
  connection: ConnectionCandidate,
  nodes: ValidityNode[],
  edges: ValidityEdge[],
  lookup: (type: string) => NodeDefinition | undefined,
): boolean {
  const { source, target, sourceHandle, targetHandle } = connection
  if (!source || !target) return false
  if (!sourceHandle || !targetHandle) return false

  const sourceNode = nodes.find((n) => n.id === source)
  const targetNode = nodes.find((n) => n.id === target)
  if (!sourceNode || !targetNode) return false

  const sourceDef = lookup(sourceNode.data.type)
  const targetDef = lookup(targetNode.data.type)
  if (!sourceDef || !targetDef) return false

  const sourcePort = sourceDef.outputs.find((p) => p.id === sourceHandle)
  const targetPort = targetPorts(targetDef, targetNode.data.params).find((p) => p.id === targetHandle)
  if (!sourcePort || !targetPort) return false

  if (!areTypesCompatible(sourcePort.type, targetPort.type)) return false

  // Refuse a wire that would close a loop. Compilation already reports
  // "Graph contains cycles", but only after the fact, and topologicalSort
  // itself has no cycle detection — it returns a mis-ordered list.
  return !wouldCreateCycle(edges, { source, target })
}
