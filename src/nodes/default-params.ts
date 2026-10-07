import type { NodeDefinition, NodeParameter } from './types'

/**
 * A parameter's default, safe to store on a node instance.
 *
 * Scalars and tuples pass through; anything structured is deep-cloned. A
 * default that is an array of objects (Stack's layer list) would otherwise be
 * the SAME object on every node created from the definition and on the
 * registry itself: undo snapshots are shallow, so one in-place edit would
 * reach every node and every snapshot, and `encodeCompactHash` strips params
 * equal to the default through a `deepEqual` that short-circuits on identity —
 * an edited-in-place list would compare equal and drop out of share URLs.
 */
export function cloneParamDefault<T>(value: T): T {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value
}

/**
 * Default params for a new node of `def`. Every site that materialises a node
 * from its definition goes through this (canvas drop, command palette, dev
 * bridge, image file drop, share-URL decode), so none of them can alias a
 * structured default.
 */
export function defaultParams(def: Pick<NodeDefinition, 'params'> | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const p of (def?.params ?? []) as NodeParameter[]) {
    if (p.default !== undefined) params[p.id] = cloneParamDefault(p.default)
  }
  return params
}
