/**
 * Live compiler hook - watches graph changes and auto-compiles
 */

import { useEffect, useRef } from 'react'
import { useGraphStore } from '../stores/graphStore'
import { useCompilerStore } from '../stores/compilerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { compileGraph } from './glsl-generator'

/**
 * Hook that automatically compiles the shader graph when it changes
 * Integrates with the compiler store to update shader code and errors
 *
 * @param onCompile Optional callback when compilation completes
 */
export function useLiveCompiler(
  onCompile?: (result: { success: boolean; fragmentShader: string }) => void
) {
  const nodes = useGraphStore((state) => state.nodes)
  const edges = useGraphStore((state) => state.edges)
  const autoCompile = useSettingsStore((state) => state.autoCompile)
  const debounceMs = useSettingsStore((state) => state.compileDebounceMs)

  const setShaders = useCompilerStore((state) => state.setShaders)
  const setErrors = useCompilerStore((state) => state.setErrors)
  const setCompiling = useCompilerStore((state) => state.setCompiling)
  const markCompileSuccess = useCompilerStore((state) => state.markCompileSuccess)

  const timeoutRef = useRef<NodeJS.Timeout>()

  useEffect(() => {
    if (!autoCompile) return

    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    // Debounced compilation
    setCompiling(true)

    timeoutRef.current = setTimeout(() => {
      try {
        const result = compileGraph(nodes, edges)

        if (result.success) {
          // Update stores with successful compilation
          setShaders(result.vertexShader, result.fragmentShader)
          markCompileSuccess()

          // Trigger callback
          onCompile?.({
            success: true,
            fragmentShader: result.fragmentShader,
          })
        } else {
          // Update error store
          setErrors(
            result.errors.map((err) => ({
              message: err.message,
              nodeId: err.nodeId,
              severity: 'error' as const,
            }))
          )

          onCompile?.({
            success: false,
            fragmentShader: '',
          })
        }
      } catch (error) {
        setErrors([
          {
            message: `Unexpected compilation error: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'error' as const,
          },
        ])

        onCompile?.({
          success: false,
          fragmentShader: '',
        })
      } finally {
        setCompiling(false)
      }
    }, debounceMs)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [nodes, edges, autoCompile, debounceMs, setShaders, setErrors, setCompiling, markCompileSuccess, onCompile])
}
