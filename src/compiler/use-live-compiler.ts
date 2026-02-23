/**
 * Live compiler hook - watches graph changes and auto-compiles
 */

import { useEffect, useMemo, useRef } from 'react'
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

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Keep latest nodes/edges in refs so they're accessible without triggering the effect
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

  // Derive semantic key from only shader-relevant data (skip selection, position, measured state)
  const semanticKey = useMemo(() => {
    const nk = nodes.map(n => `${n.id}:${JSON.stringify(n.data)}`).join('|')
    const ek = edges.map(e => `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`).join('|')
    return nk + '||' + ek
  }, [nodes, edges])

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
        const result = compileGraph(nodesRef.current, edgesRef.current)

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanticKey, autoCompile, debounceMs, setShaders, setErrors, setCompiling, markCompileSuccess, onCompile])
}
