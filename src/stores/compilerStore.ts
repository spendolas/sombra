/**
 * Compiler store - manages shader compilation state and errors
 */

import { create } from 'zustand'

/**
 * Compilation error interface
 */
export interface CompilationError {
  nodeId?: string        // Node that caused the error (if known)
  message: string        // Error message
  line?: number          // Line number in generated GLSL (if applicable)
  severity: 'error' | 'warning'
}

/**
 * Compiler state interface
 */
interface CompilerState {
  // Compiled shader code
  vertexShader: string | null
  fragmentShader: string | null
  wgslShader: string | null       // WGSL shader source (when IR compilation succeeds)

  // Compilation status
  isCompiling: boolean
  lastCompileTime: number | null  // Timestamp of last successful compile

  // Errors
  errors: CompilationError[]
  hasErrors: boolean

  // Actions
  setShaders: (vertex: string, fragment: string, wgsl?: string | null) => void
  setFragmentShader: (fragment: string) => void
  setWgslShader: (wgsl: string | null) => void
  setCompiling: (isCompiling: boolean) => void
  setErrors: (errors: CompilationError[]) => void
  addError: (error: CompilationError) => void
  clearErrors: () => void
  markCompileSuccess: () => void

  // Utility
  getErrorsForNode: (nodeId: string) => CompilationError[]
}

/**
 * Compiler store - manages shader compilation
 */
export const useCompilerStore = create<CompilerState>((set, get) => ({
  vertexShader: null,
  fragmentShader: null,
  wgslShader: null,
  isCompiling: false,
  lastCompileTime: null,
  errors: [],
  hasErrors: false,

  setShaders: (vertex, fragment, wgsl) =>
    set({
      vertexShader: vertex,
      fragmentShader: fragment,
      wgslShader: wgsl ?? null,
    }),

  setFragmentShader: (fragment) =>
    set({ fragmentShader: fragment }),

  setWgslShader: (wgsl) =>
    set({ wgslShader: wgsl }),

  setCompiling: (isCompiling) =>
    set({ isCompiling }),

  setErrors: (errors) =>
    set({
      errors,
      hasErrors: errors.length > 0,
    }),

  addError: (error) =>
    set((state) => ({
      errors: [...state.errors, error],
      hasErrors: true,
    })),

  clearErrors: () =>
    set({
      errors: [],
      hasErrors: false,
    }),

  markCompileSuccess: () =>
    set({
      lastCompileTime: Date.now(),
      errors: [],
      hasErrors: false,
    }),

  getErrorsForNode: (nodeId) =>
    get().errors.filter((error) => error.nodeId === nodeId),
}))
