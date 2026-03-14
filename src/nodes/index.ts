/**
 * Node library - imports and registers all available nodes
 */

import { registerNodes, nodeRegistry } from './registry'

// Input nodes
import { uvCoordsNode } from './input/uv-coords'
import { colorConstantNode } from './input/color-constant'
import { floatConstantNode } from './input/float-constant'
import { vec2ConstantNode } from './input/vec2-constant'
import { timeNode } from './input/time'
import { resolutionNode } from './input/resolution'
import { randomNode } from './input/random'

// Math nodes
import { arithmeticNode } from './math/arithmetic'
import { trigNode } from './math/trig'
import { mixNode } from './math/mix'
import { remapNode } from './math/remap'
import { clampNode } from './math/clamp'
import { powerNode } from './math/power'
import { roundNode } from './math/round'

// Distort nodes
import { smoothstepNode } from './math/smoothstep'
import { turbulenceNode } from './math/turbulence'
import { ridgedNode } from './math/ridged'

// Noise nodes
import { noiseNode } from './noise/noise'
import { fbmNode } from './noise/fbm'

// Transform nodes
import { domainWarpNode } from './noise/domain-warp'
import { quantizeUvNode } from './postprocess/quantize-uv'
import { polarCoordsNode } from './transform/polar-coords'
import { tileNode } from './transform/tile'
import { reededGlassNode } from './transform/reeded-glass'

// Color nodes
import { hsvToRgbNode } from './color/hsv-to-rgb'
import { brightnessContrastNode } from './color/brightness-contrast'
import { colorRampNode } from './color/color-ramp'
import { invertNode } from './color/invert'
import { grayscaleNode } from './color/grayscale'
import { posterizeNode } from './color/posterize'

// Pattern nodes
import { checkerboardNode } from './pattern/checkerboard'
import { stripesNode } from './pattern/stripes'
import { dotsNode } from './pattern/dots'
import { gradientNode } from './pattern/gradient'

// Vector nodes
import { splitVec3Node } from './vector/split-vec3'
import { combineVec3Node } from './vector/combine-vec3'
import { splitVec2Node } from './vector/split-vec2'
import { combineVec2Node } from './vector/combine-vec2'

// Effect nodes
import { ditherNode } from './postprocess/pixel-grid'

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
  randomNode,

  // Math
  arithmeticNode,
  trigNode,
  mixNode,
  remapNode,
  clampNode,
  powerNode,
  roundNode,

  // Distort
  smoothstepNode,
  turbulenceNode,
  ridgedNode,

  // Noise
  noiseNode,
  fbmNode,

  // Transform
  domainWarpNode,
  quantizeUvNode,
  polarCoordsNode,
  tileNode,
  reededGlassNode,

  // Color
  hsvToRgbNode,
  brightnessContrastNode,
  colorRampNode,
  invertNode,
  grayscaleNode,
  posterizeNode,

  // Pattern
  checkerboardNode,
  stripesNode,
  dotsNode,
  gradientNode,

  // Vector
  splitVec3Node,
  combineVec3Node,
  splitVec2Node,
  combineVec2Node,

  // Effect
  ditherNode,

  // Output
  fragmentOutputNode,
]

/**
 * Initialize the node library by registering all nodes.
 * Safe to call in both main thread and Web Worker contexts.
 */
export function initializeNodeLibrary(): void {
  registerNodes(ALL_NODES)
  console.log(`[Sombra] Registered ${ALL_NODES.length} node types`)
}

/**
 * Attach React component references to node definitions that have custom UI.
 * Must be called on the main thread only (after initializeNodeLibrary).
 * Worker contexts skip this — they only need the glsl() functions.
 */
export async function bindNodeComponents(): Promise<void> {
  const { ColorRampEditor } = await import('@/components/ColorRampEditor')
  const { RandomDisplay } = await import('../components/RandomDisplay')

  const colorRamp = nodeRegistry.get('color_ramp')
  if (colorRamp) colorRamp.component = ColorRampEditor

  const random = nodeRegistry.get('random')
  if (random) random.component = RandomDisplay
}

// Re-export for convenience
export * from './types'
export * from './registry'
export * from './type-coercion'
