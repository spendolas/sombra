/**
 * Node library - imports and registers all available nodes
 */

import { registerNodes } from './registry'

// Input nodes
import { uvCoordsNode } from './input/uv-coords'
import { colorConstantNode } from './input/color-constant'
import { floatConstantNode } from './input/float-constant'
import { vec2ConstantNode } from './input/vec2-constant'
import { timeNode } from './input/time'
import { resolutionNode } from './input/resolution'

// Math nodes
import { arithmeticNode } from './math/arithmetic'
import { trigNode } from './math/trig'
import { mixNode } from './math/mix'
import { smoothstepNode } from './math/smoothstep'
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
import { colorRampNode } from './color/color-ramp'

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
  vec2ConstantNode,
  timeNode,
  resolutionNode,

  // Math
  arithmeticNode,
  trigNode,
  mixNode,
  smoothstepNode,
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
  colorRampNode,

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
