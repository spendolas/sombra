/**
 * Live compiler hook - watches graph changes and auto-compiles via Web Worker.
 * Structural changes dispatch to an off-thread worker; uniform slider changes
 * take a synchronous fast path on the main thread (no recompile).
 */

import { useEffect, useMemo, useRef } from 'react'
import { useGraphStore } from '../stores/graphStore'
import { useCompilerStore } from '../stores/compilerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { nodeRegistry } from '../nodes/registry'
import type { UniformSpec } from '../nodes/types'
import type { RenderPass } from './glsl-generator'
import type { CompileResponse } from './compiler.worker'
import CompilerWorker from './compiler.worker?worker'

/**
 * Hook that automatically compiles the shader graph when it changes.
 * Separates structural changes (recompile via Worker) from uniform slider
 * changes (fast upload on main thread) from renderer-only changes (no GPU work).
 *
 * @param onCompile Callback when full recompilation completes
 * @param onUniformUpdate Callback when only uniform values change (no recompile)
 * @param onRendererUpdate Callback when only renderer settings change (no recompile or uniform upload)
 */
export function useLiveCompiler(
  onCompile?: (result: {
    success: boolean
    fragmentShader: string
    userUniforms?: UniformSpec[]
    isTimeLiveAtOutput?: boolean
    qualityTier?: string
    passes?: RenderPass[]
  }) => void,
  onUniformUpdate?: (
    uniforms: Array<{ name: string; value: number | number[] }>
  ) => void,
  onRendererUpdate?: (update: { qualityTier: string }) => void
) {
  const nodes = useGraphStore((state) => state.nodes)
  const edges = useGraphStore((state) => state.edges)
  const autoCompile = useSettingsStore((state) => state.autoCompile)
  const initialDebounceMs = useSettingsStore((state) => state.compileDebounceMs)

  const setShaders = useCompilerStore((state) => state.setShaders)
  const setErrors = useCompilerStore((state) => state.setErrors)
  const setCompiling = useCompilerStore((state) => state.setCompiling)
  const markCompileSuccess = useCompilerStore((state) => state.markCompileSuccess)

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const workerRef = useRef<Worker | null>(null)
  const currentCompileId = useRef<string | null>(null)

  // Keep latest nodes/edges in refs so they're accessible without triggering the effect
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

  // Track last compiled uniform specs for the fast path
  const lastUniformsRef = useRef<UniformSpec[]>([])
  const lastSemanticKeyRef = useRef('')
  const lastRendererKeyRef = useRef('')

  // Dynamic debounce — adapts to actual compile duration
  const lastCompileDuration = useRef(initialDebounceMs)

  // Stable callback refs — avoid effect re-triggers when callback identity changes
  const onCompileRef = useRef(onCompile)
  const onUniformUpdateRef = useRef(onUniformUpdate)
  const onRendererUpdateRef = useRef(onRendererUpdate)
  onCompileRef.current = onCompile
  onUniformUpdateRef.current = onUniformUpdate
  onRendererUpdateRef.current = onRendererUpdate

  // --- Worker lifecycle: create once on mount, terminate on unmount ---
  useEffect(() => {
    const worker = new CompilerWorker()
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<CompileResponse>) => {
      const { id, result, error, durationMs } = event.data

      // Discard stale results — a newer compile was dispatched
      if (id !== currentCompileId.current) return

      lastCompileDuration.current = durationMs

      if (error) {
        setErrors([
          {
            message: `Unexpected compilation error: ${error}`,
            severity: 'error' as const,
          },
        ])
        setShaders('', '')
        setCompiling(false)
        onCompileRef.current?.({ success: false, fragmentShader: '' })
        return
      }

      if (result?.success) {
        setShaders(result.vertexShader, result.fragmentShader)
        markCompileSuccess()
        lastUniformsRef.current = result.userUniforms

        onCompileRef.current?.({
          success: true,
          fragmentShader: result.fragmentShader,
          userUniforms: result.userUniforms,
          isTimeLiveAtOutput: result.isTimeLiveAtOutput,
          qualityTier: result.qualityTier,
          passes: result.passes,
        })
      } else {
        setErrors(
          (result?.errors ?? []).map((err) => ({
            message: err.message,
            nodeId: err.nodeId,
            severity: 'error' as const,
          }))
        )
        setShaders('', '')

        onCompileRef.current?.({ success: false, fragmentShader: '' })
      }

      setCompiling(false)
    }

    worker.onerror = (event) => {
      console.error('[Sombra] Compiler worker error:', event.message, event)
      setCompiling(false)
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [setShaders, setErrors, setCompiling, markCompileSuccess])

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

  // Derive renderer key from renderer-mode param values only
  const rendererKey = useMemo(() => {
    return nodes
      .map((n) => {
        const def = nodeRegistry.get(n.data.type)
        if (!def?.params) return ''
        return def.params
          .filter((p) => p.updateMode === 'renderer')
          .map(
            (p) =>
              `${n.id}:${p.id}:${JSON.stringify(n.data.params?.[p.id] ?? p.default)}`
          )
          .join(',')
      })
      .filter(Boolean)
      .join('|')
  }, [nodes])

  // --- Dispatch effect: compile via Worker or fast-path uniform upload ---
  useEffect(() => {
    if (!autoCompile) return

    // Clear existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    const rendererChanged = rendererKey !== lastRendererKeyRef.current
    const semanticChanged = semanticKey !== lastSemanticKeyRef.current

    // Renderer-only path — no debounce, no recompile, no uniform upload
    if (rendererChanged && !semanticChanged) {
      lastRendererKeyRef.current = rendererKey
      const outputNode = nodesRef.current.find((n) => n.data.type === 'fragment_output')
      const qualityTier = (outputNode?.data.params?.quality as string) ?? 'adaptive'
      onRendererUpdateRef.current?.({ qualityTier })
      return
    }

    // Dynamic debounce: clamp(lastDuration * 0.8, 50, 300)
    const delay = Math.min(
      300,
      Math.max(50, lastCompileDuration.current * 0.8)
    )

    if (semanticChanged) {
      // Full recompile path — dispatch to Worker
      setCompiling(true)

      timeoutRef.current = setTimeout(() => {
        const id = crypto.randomUUID()
        currentCompileId.current = id
        lastSemanticKeyRef.current = semanticKey
        workerRef.current?.postMessage({
          id,
          nodes: nodesRef.current,
          edges: edgesRef.current,
        })
      }, delay)
    } else {
      // Fast uniform-only path — no recompile, stays on main thread
      timeoutRef.current = setTimeout(() => {
        const specs = lastUniformsRef.current
        if (!specs.length || !onUniformUpdateRef.current) return

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
          onUniformUpdateRef.current(values)
        }
      }, delay)
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [
    semanticKey,
    uniformKey,
    rendererKey,
    autoCompile,
    setCompiling,
  ])
}
