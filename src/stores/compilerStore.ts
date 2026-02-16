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

  // Compilation status
  isCompiling: boolean
  lastCompileTime: number | null  // Timestamp of last successful compile

  // Errors
  errors: CompilationError[]
  hasErrors: boolean

  // Actions
  setShaders: (vertex: string, fragment: string) => void
  setFragmentShader: (fragment: string) => void
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
  isCompiling: false,
  lastCompileTime: null,
  errors: [],
  hasErrors: false,

  setShaders: (vertex, fragment) =>
    set({
      vertexShader: vertex,
      fragmentShader: fragment,
    }),

  setFragmentShader: (fragment) =>
    set({ fragmentShader: fragment }),

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
