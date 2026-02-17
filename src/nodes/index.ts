/**
 * Node library - imports and registers all available nodes
 */

import { registerNodes } from './registry'

// Input nodes
import { uvCoordsNode } from './input/uv-coords'
import { colorConstantNode } from './input/color-constant'
import { floatConstantNode } from './input/float-constant'
import { timeNode } from './input/time'
import { resolutionNode } from './input/resolution'

// Math nodes
import { addNode } from './math/add'
import { multiplyNode } from './math/multiply'
import { mixNode } from './math/mix'
import { smoothstepNode } from './math/smoothstep'
import { sinNode } from './math/sin'
import { cosNode } from './math/cos'
import { remapNode } from './math/remap'
import { turbulenceNode } from './math/turbulence'
import { ridgedNode } from './math/ridged'

// Noise nodes
import { noiseNode } from './noise/noise'
import { fbmNode } from './noise/fbm'
import { domainWarpNode } from './noise/domain-warp'

// Color nodes
import { hsvToRgbNode } from './color/hsv-to-rgb'
import { brightnessContrastNode } from './color/brightness-contrast'

// Output nodes
import { fragmentOutputNode } from './output/fragment-output'

/**
 * All available node definitions
 */
export const ALL_NODES = [
  // Input
  uvCoordsNode,
  colorConstantNode,
  floatConstantNode,
  timeNode,
  resolutionNode,

  // Math
  addNode,
  multiplyNode,
  mixNode,
  smoothstepNode,
  sinNode,
  cosNode,
  remapNode,
  turbulenceNode,
  ridgedNode,

  // Noise
  noiseNode,
  fbmNode,
  domainWarpNode,

  // Color
  hsvToRgbNode,
  brightnessContrastNode,

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
