/**
 * Core type definitions for the Sombra node system
 */

/**
 * Port data types supported by the shader system
 */
export type PortType =
  | 'float'      // Single floating point value
  | 'vec2'       // 2D vector
  | 'vec3'       // 3D vector (RGB color)
  | 'vec4'       // 4D vector (RGBA color)
  | 'color'      // Alias for vec3, UI shows color picker
  | 'sampler2D'  // Texture sampler (future)
  | 'fnref'      // GLSL function name reference (higher-order composition)

/**
 * Definition of an input or output port on a node
 */
export interface PortDefinition {
  id: string           // Unique identifier within the node (e.g., "input", "color1")
  label: string        // Display name for the port
  type: PortType       // Data type
  default?: unknown    // Default value when port is unconnected
}

/**
 * Parameters that can be tweaked in the node UI
 */
export interface NodeParameter {
  id: string                    // Unique identifier (e.g., "scale", "strength")
  label: string                 // Display name
  type: 'float' | 'vec2' | 'vec3' | 'color' | 'enum'
  default: number | string | [number, number] | [number, number, number]
  min?: number                  // For numeric types
  max?: number                  // For numeric types
  step?: number                 // Step increment for sliders
  options?: Array<{ value: string; label: string }>  // For enum type
  showWhen?: Record<string, string>                  // Only show when other params match these values
  connectable?: boolean                              // If true, renders as wirable handle + inline slider
  hidden?: boolean                                   // If true, param is not rendered in UI (internal state)
}

/**
 * Context passed to GLSL generator functions
 */
export interface GLSLContext {
  nodeId: string                           // Unique node instance ID
  inputs: Record<string, string>           // Input port IDs -> variable names
  outputs: Record<string, string>          // Output port IDs -> variable names
  params: Record<string, unknown>          // Parameter values
  uniforms: Set<string>                    // Global uniforms to declare
  functions: string[]                      // Global function declarations (outside main)
  functionRegistry: Map<string, string>    // Deduplicated shared functions (key -> GLSL code)
}

/**
 * Register a shared GLSL function. Skips if key already registered.
 * Use this instead of pushing to functions[] directly.
 */
export function addFunction(ctx: GLSLContext, key: string, code: string): void {
  if (!ctx.functionRegistry.has(key)) {
    ctx.functionRegistry.set(key, code)
  }
}

/**
 * Complete definition of a node type
 */
export interface NodeDefinition {
  type: string                             // Node type identifier (e.g., "simplex_noise")
  label: string                            // Display name (e.g., "Simplex Noise")
  category: string                         // Category for organization (e.g., "Noise", "Math")

  inputs: PortDefinition[]                 // Input ports
  outputs: PortDefinition[]                // Output ports
  params?: NodeParameter[]                 // Tweakable parameters

  /**
   * Optional function returning per-instance inputs based on current params.
   * Used by nodes with variable port count (e.g., Arithmetic with 2-8 inputs).
   * When present, compiler and UI use this instead of static `inputs`.
   */
  dynamicInputs?: (params: Record<string, unknown>) => PortDefinition[]

  /**
   * GLSL function name this node provides via fnref output ports.
   * Convention: all fnref noise functions share signature `float name(vec3 p)`.
   * Can be a string or a function that returns a string based on current params.
   */
  functionKey?: string | ((params: Record<string, unknown>) => string)

  /**
   * Generate GLSL code for this node
   * @param ctx Context with node ID, port mappings, parameter values
   * @returns GLSL code snippet (variable declarations + calculations)
   */
  glsl: (ctx: GLSLContext) => string

  /**
   * Optional custom React component for node body
   * If not provided, default UI with parameter controls is used
   */
  component?: React.ComponentType<{ nodeId: string; data: Record<string, unknown> }>

  /**
   * Optional description for tooltips/help
   */
  description?: string
}

/**
 * Type coercion rules for connecting mismatched port types
 */
export type CoercionRule = {
  from: PortType
  to: PortType
  glsl: (varName: string) => string  // GLSL conversion expression
}

/**
 * Runtime node instance data (stored in React Flow)
 */
export interface NodeData extends Record<string, unknown> {
  type: string                      // References NodeDefinition.type
  params: Record<string, unknown>   // Current parameter values
  label?: string                    // Optional custom label
}

/**
 * Edge connection data
 */
export interface EdgeData extends Record<string, unknown> {
  sourcePort: string       // Source output port ID
  targetPort: string       // Target input port ID
  sourcePortType?: string  // Port type for edge coloring
}
