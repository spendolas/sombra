/**
 * Live compiler hook - watches graph changes and auto-compiles
 */

import { useEffect, useMemo, useRef } from 'react'
import { useGraphStore } from '../stores/graphStore'
import { useCompilerStore } from '../stores/compilerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { compileGraph } from './glsl-generator'
import { nodeRegistry } from '../nodes/registry'
import type { UniformSpec } from '../nodes/types'

/**
 * Hook that automatically compiles the shader graph when it changes.
 * Separates structural changes (recompile) from uniform slider changes (fast upload).
 *
 * @param onCompile Callback when full recompilation completes
 * @param onUniformUpdate Callback when only uniform values change (no recompile)
 */
export function useLiveCompiler(
  onCompile?: (result: {
    success: boolean
    fragmentShader: string
    userUniforms?: UniformSpec[]
    isTimeLiveAtOutput?: boolean
  }) => void,
  onUniformUpdate?: (
    uniforms: Array<{ name: string; value: number | number[] }>
  ) => void
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

  // Track last compiled uniform specs for the fast path
  const lastUniformsRef = useRef<UniformSpec[]>([])
  const lastSemanticKeyRef = useRef('')

  // Derive semantic key from only structural (recompile-mode) data
  const semanticKey = useMemo(() => {
    const nk = nodes
      .map((n) => {
        const def = nodeRegistry.get(n.data.type)
        const structural: Record<string, unknown> = {}
        if (def?.params) {
          for (const p of def.params) {
            if (p.updateMode === 'recompile')
              structural[p.id] = n.data.params?.[p.id] ?? p.default
          }
        }
        return `${n.id}:${n.data.type}:${JSON.stringify(structural)}`
      })
      .join('|')
    const ek = edges
      .map(
        (e) =>
          `${e.source}:${e.sourceHandle}->${e.target}:${e.targetHandle}`
      )
      .join('|')
    return nk + '||' + ek
  }, [nodes, edges])

  // Derive uniform key from uniform-mode param values only
  const uniformKey = useMemo(() => {
    return nodes
      .map((n) => {
        const def = nodeRegistry.get(n.data.type)
        if (!def?.params) return ''
        return def.params
          .filter((p) => p.updateMode === 'uniform')
          .map(
            (p) =>
              `${n.id}:${p.id}:${JSON.stringify(n.data.params?.[p.id] ?? p.default)}`
          )
          .join(',')
      })
      .filter(Boolean)
      .join('|')
  }, [nodes])

  useEffect(() => {
    if (!autoCompile) return

    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    const semanticChanged = semanticKey !== lastSemanticKeyRef.current

    if (semanticChanged) {
      // Full recompile path
      setCompiling(true)

      timeoutRef.current = setTimeout(() => {
        try {
          const result = compileGraph(nodesRef.current, edgesRef.current)

          if (result.success) {
            setShaders(result.vertexShader, result.fragmentShader)
            markCompileSuccess()
            lastUniformsRef.current = result.userUniforms
            lastSemanticKeyRef.current = semanticKey

            onCompile?.({
              success: true,
              fragmentShader: result.fragmentShader,
              userUniforms: result.userUniforms,
              isTimeLiveAtOutput: result.isTimeLiveAtOutput,
            })
          } else {
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
    } else {
      // Fast uniform-only path — no recompile
      timeoutRef.current = setTimeout(() => {
        const specs = lastUniformsRef.current
        if (!specs.length || !onUniformUpdate) return

        // Build current edge set for wired-param detection
        const currentEdges = edgesRef.current
        const wiredTargets = new Set(
          currentEdges.map((e) => `${e.target}:${e.targetHandle}`)
        )

        const values: Array<{ name: string; value: number | number[] }> = []
        const currentNodes = nodesRef.current
        const nodeMap = new Map(currentNodes.map((n) => [n.id, n]))

        for (const spec of specs) {
          // Skip if this param is now wired (no uniform needed)
          if (wiredTargets.has(`${spec.nodeId}:${spec.paramId}`)) continue

          const node = nodeMap.get(spec.nodeId)
          if (!node) continue

          const currentValue = node.data.params?.[spec.paramId]
          if (currentValue !== undefined) {
            values.push({ name: spec.name, value: currentValue as number | number[] })
          } else {
            values.push({ name: spec.name, value: spec.value })
          }
        }

        if (values.length > 0) {
          onUniformUpdate(values)
        }
      }, debounceMs)
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    semanticKey,
    uniformKey,
    autoCompile,
    debounceMs,
    setShaders,
    setErrors,
    setCompiling,
    markCompileSuccess,
    onCompile,
    onUniformUpdate,
  ])
}
