import type { NodeDefinition, NodeParameter, PortDefinition } from './types'

/**
 * The parameters a specific node instance actually has.
 *
 * Every site that iterates `definition.params` must go through this, or it sees
 * a different parameter set than codegen does. That divergence is silent: the
 * shader compiles, the uniform is simply absent, and the control does nothing.
 *
 * Returns `def.params` unchanged for nodes without `dynamicParams`, which is
 * every shipped node — so existing behaviour is untouched by construction.
 */
/**
 * The input ports a USER may wire on this node instance: its inputs (static
 * or per-instance) minus `internal` ones, which only the framework wires. Every
 * site that decides whether a stored or proposed edge is legitimate goes
 * through this — connect, file import, share-URL decode, persisted-state
 * migration — so a crafted file cannot reach an internal port either.
 */
export function userInputs(
  def: NodeDefinition,
  nodeParams: Record<string, unknown> | undefined,
): PortDefinition[] {
  const inputs = def.dynamicInputs ? def.dynamicInputs(nodeParams ?? {}) : def.inputs
  return inputs.filter((p) => !p.internal)
}

export function resolveParams(
  def: NodeDefinition,
  nodeParams: Record<string, unknown> | undefined,
): NodeParameter[] {
  if (!def.dynamicParams) return def.params ?? []
  return def.dynamicParams(nodeParams ?? {})
}
