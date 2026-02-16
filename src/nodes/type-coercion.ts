/**
 * Type coercion rules for automatic conversion between port types
 */

import type { PortType, CoercionRule } from './types'

/**
 * Coercion rules define how to convert between different port types in GLSL
 *
 * Examples:
 * - float -> vec3: broadcast the float to all three components
 * - vec4 -> vec3: drop the alpha channel
 * - vec2 -> vec3: add 0.0 for the z component
 */
export const COERCION_RULES: CoercionRule[] = [
  // float -> vec2, vec3, vec4 (broadcast)
  {
    from: 'float',
    to: 'vec2',
    glsl: (v) => `vec2(${v})`,
  },
  {
    from: 'float',
    to: 'vec3',
    glsl: (v) => `vec3(${v})`,
  },
  {
    from: 'float',
    to: 'vec4',
    glsl: (v) => `vec4(${v})`,
  },

  // vec2 -> vec3, vec4 (add zeros)
  {
    from: 'vec2',
    to: 'vec3',
    glsl: (v) => `vec3(${v}, 0.0)`,
  },
  {
    from: 'vec2',
    to: 'vec4',
    glsl: (v) => `vec4(${v}, 0.0, 1.0)`,
  },

  // vec3 -> vec4 (add alpha = 1.0)
  {
    from: 'vec3',
    to: 'vec4',
    glsl: (v) => `vec4(${v}, 1.0)`,
  },

  // vec4 -> vec3 (drop alpha)
  {
    from: 'vec4',
    to: 'vec3',
    glsl: (v) => `${v}.rgb`,
  },

  // vec3 -> vec2 (drop z)
  {
    from: 'vec3',
    to: 'vec2',
    glsl: (v) => `${v}.xy`,
  },

  // vec4 -> vec2 (drop z, w)
  {
    from: 'vec4',
    to: 'vec2',
    glsl: (v) => `${v}.xy`,
  },

  // color is an alias for vec3
  {
    from: 'color',
    to: 'vec3',
    glsl: (v) => v,
  },
  {
    from: 'vec3',
    to: 'color',
    glsl: (v) => v,
  },
]

/**
 * Find a coercion rule for converting from one type to another
 * @param from Source port type
 * @param to Target port type
 * @returns Coercion rule if found, null if no conversion possible
 */
export function findCoercionRule(
  from: PortType,
  to: PortType
): CoercionRule | null {
  // Same type, no coercion needed
  if (from === to) {
    return { from, to, glsl: (v) => v }
  }

  // Find matching rule
  return COERCION_RULES.find((rule) => rule.from === from && rule.to === to) || null
}

/**
 * Check if two port types are compatible (can be connected)
 * @param from Source port type
 * @param to Target port type
 * @returns True if connection is valid
 */
export function areTypesCompatible(from: PortType, to: PortType): boolean {
  return findCoercionRule(from, to) !== null
}

/**
 * Apply type coercion to a variable name
 * @param varName GLSL variable name
 * @param from Source type
 * @param to Target type
 * @returns GLSL expression with coercion applied
 */
export function coerceType(
  varName: string,
  from: PortType,
  to: PortType
): string {
  const rule = findCoercionRule(from, to)
  if (!rule) {
    throw new Error(`Cannot coerce ${from} to ${to}`)
  }
  return rule.glsl(varName)
}
