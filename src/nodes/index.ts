/**
 * Node library - imports and registers all available nodes
 */

import { registerNodes } from './registry'

// Input nodes
import { uvCoordsNode } from './input/uv-coords'
import { colorConstantNode } from './input/color-constant'
import { timeNode } from './input/time'

// Math nodes
import { addNode } from './math/add'
import { multiplyNode } from './math/multiply'
import { mixNode } from './math/mix'

// Output nodes
import { fragmentOutputNode } from './output/fragment-output'

/**
 * All available node definitions
 */
export const ALL_NODES = [
  // Input
  uvCoordsNode,
  colorConstantNode,
  timeNode,

  // Math
  addNode,
  multiplyNode,
  mixNode,

  // Output
  fragmentOutputNode,
]

/**
 * Initialize the node library by registering all nodes
 * Call this once at app startup
 */
export function initializeNodeLibrary(): void {
  registerNodes(ALL_NODES)
  console.log(`[Sombra] Registered ${ALL_NODES.length} node types`)
}

// Re-export for convenience
export * from './types'
export * from './registry'
export * from './type-coercion'
