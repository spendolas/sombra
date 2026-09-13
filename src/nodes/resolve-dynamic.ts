import type { NodeDefinition, NodeParameter } from './types'

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
export function resolveParams(
  def: NodeDefinition,
  nodeParams: Record<string, unknown> | undefined,
): NodeParameter[] {
  if (!def.dynamicParams) return def.params ?? []
  return def.dynamicParams(nodeParams ?? {})
}
