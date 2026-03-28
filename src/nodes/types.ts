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

/**
 * Definition of an input or output port on a node
 */
export interface PortDefinition {
  id: string           // Unique identifier within the node (e.g., "input", "color1")
  label: string        // Display name for the port
  type: PortType       // Data type
  default?: unknown    // Default value when port is unconnected
  textureInput?: boolean  // When true + wired, triggers a pass boundary (multi-pass rendering)
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
  showWhen?: Record<string, string | string[]>        // Only show when other params match (array = any of)
  connectable?: boolean                              // If true, renders as wirable handle + inline slider
  hidden?: boolean                                   // If true, param is not rendered in UI (internal state)
  warnAbove?: number                                  // Show performance hint when unwired value exceeds this
  /**
   * Controls how a parameter change is handled by the compiler and renderer.
   *
   * - 'recompile': value is baked into GLSL source at codegen time.
   *   Any change requires full shader recompilation.
   *   Use for: enum modes, structural counts, branch-shaping params.
   *
   * - 'uniform': value is emitted as a GLSL uniform and uploaded at runtime.
   *   Changes require only a uniform upload — no recompile.
   *   Use for: scale, strength, offset, frequency, amplitude, numeric multipliers.
   *
   * - 'renderer': value controls renderer settings (FPS, DPR) only.
   *   Changes require no recompile or uniform upload — just renderer state.
   *   Use for: quality tiers, render mode switches.
   */
  updateMode: 'recompile' | 'uniform' | 'renderer'
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
  textureSamplers?: Record<string, string> // portId → sampler2D uniform name (multi-pass)
  imageSamplers?: Set<string>              // Image node sampler2D uniform names
}

/**
 * Spatial transform configuration for framework-managed SRT
 */
export interface SpatialConfig {
  transforms: Array<'scale' | 'scaleXY' | 'rotate' | 'translate'>
  order?: 'SRT' | 'TRS' | 'RST'  // default: 'SRT'
}

/**
 * Generate framework SRT param definitions from a SpatialConfig.
 * Include these in the node's `params` array via spread: `...getSpatialParams(spatial)`.
 */
export function getSpatialParams(spatial: SpatialConfig): NodeParameter[] {
  const params: NodeParameter[] = []
  for (const transform of spatial.transforms) {
    switch (transform) {
      case 'scale':
        params.push({
          id: 'srt_scale', label: 'Scale', type: 'float', default: 1.0,
          min: 0, max: 2.0, step: 0.01,
          connectable: true, updateMode: 'uniform',
        })
        break
      case 'scaleXY':
        params.push(
          {
            id: 'srt_scaleX', label: 'Scale X', type: 'float', default: 1.0,
            min: 0, max: 10.0, step: 0.01,
            connectable: true, updateMode: 'uniform',
          },
          {
            id: 'srt_scaleY', label: 'Scale Y', type: 'float', default: 1.0,
            min: 0, max: 10.0, step: 0.01,
            connectable: true, updateMode: 'uniform',
          },
        )
        break
      case 'rotate':
        params.push({
          id: 'srt_rotate', label: 'Rotate', type: 'float', default: 0,
          min: -180, max: 180, step: 1,
          connectable: true, updateMode: 'uniform',
        })
        break
      case 'translate':
        params.push(
          {
            id: 'srt_translateX', label: 'Offset X', type: 'float', default: 0,
            min: -500, max: 500, step: 1,
            connectable: true, updateMode: 'uniform',
          },
          {
            id: 'srt_translateY', label: 'Offset Y', type: 'float', default: 0,
            min: -500, max: 500, step: 1,
            connectable: true, updateMode: 'uniform',
          },
        )
        break
    }
  }
  return params
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
   * Framework-managed spatial transforms (SRT).
   * When present, the compiler auto-injects scale/rotate/translate uniforms and GLSL.
   */
  spatial?: SpatialConfig

  /**
   * Optional description for tooltips/help
   */
  description?: string

  /**
   * Hide the auto-generated mini-preview thumbnail on this node.
   * Use for nodes that have their own preview (e.g., Image) or where preview is meaningless (e.g., Time).
   */
  hidePreview?: boolean

  /**
   * Show preview only when at least one input is connected.
   * Use for scalar math nodes (Arithmetic, Trig, etc.) whose preview
   * is only meaningful when a visual pattern is wired in.
   */
  conditionalPreview?: boolean

  /**
   * Texture filtering for this node's FBO output in multi-pass chains.
   * 'nearest' preserves hard edges (e.g., pixel blocks from Pixelate).
   * Defaults to 'linear' if not set.
   */
  textureFilter?: 'linear' | 'nearest'
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
 * Describes a user-defined GLSL uniform extracted during codegen.
 * One per unwired 'uniform'-mode param per active node.
 */
export interface UniformSpec {
  /** GLSL uniform name, e.g. "u_abc123_scale" */
  name: string
  /** GLSL type — determines which gl.uniform* call to use */
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  /** Current value at compile time — used for initial upload after updateShader() */
  value: number | number[]
  /** React Flow node ID (unsanitized) */
  nodeId: string
  /** NodeParameter.id */
  paramId: string
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
