/**
 * Live compiler hook - watches graph changes and auto-compiles via Web Worker.
 * Structural changes dispatch to an off-thread worker; uniform slider changes
 * take a synchronous fast path on the main thread (no recompile).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
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
    wgsl?: import('./glsl-generator').RenderPlan['wgsl']
  }) => void,
  onUniformUpdate?: (
    uniforms: Array<{ name: string; value: number | number[] }>
  ) => void,
  onRendererUpdate?: (update: { qualityTier: string; anchor: string }) => void,
  /** When true, the worker also produces WGSL output via the IR path. */
  useIR?: boolean,
) {
  const nodes = useGraphStore((state) => state.nodes)
  const edges = useGraphStore((state) => state.edges)
  const autoCompile = useSettingsStore((state) => state.autoCompile)
  const initialDebounceMs = useSettingsStore((state) => state.compileDebounceMs)

  const setShaders = useCompilerStore((state) => state.setShaders)
  const setErrors = useCompilerStore((state) => state.setErrors)
  const setCompiling = useCompilerStore((state) => state.setCompiling)
  const markCompileSuccess = useCompilerStore((state) => state.markCompileSuccess)

  // Separate timers: a slider drag must not reset a pending semantic compile
  // (starvation) and a structural edit must not swallow a pending uniform push.
  const semanticTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const uniformTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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

  // Dynamic debounce — adapts to actual compile duration
  const lastCompileDuration = useRef(initialDebounceMs)

  // Stable callback refs — avoid effect re-triggers when callback identity changes
  const onCompileRef = useRef(onCompile)
  const onUniformUpdateRef = useRef(onUniformUpdate)
  const onRendererUpdateRef = useRef(onRendererUpdate)
  onCompileRef.current = onCompile
  onUniformUpdateRef.current = onUniformUpdate
  onRendererUpdateRef.current = onRendererUpdate

  /**
   * Resolve the CURRENT value of every unwired uniform param from the live
   * graph. Used by the fast path and by the post-compile re-apply: the plan
   * the renderer just received carries dispatch-time values, so any slider
   * moved while the compile was in flight would otherwise snap back.
   */
  const collectCurrentUniformValues = useCallback(() => {
    const specs = lastUniformsRef.current
    if (!specs.length) return []

    const wiredTargets = new Set(
      edgesRef.current.map((e) => `${e.target}:${e.targetHandle}`)
    )
    const nodeMap = new Map(nodesRef.current.map((n) => [n.id, n]))

    const values: Array<{ name: string; value: number | number[] }> = []
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
    return values
  }, [])

  // --- Worker lifecycle: spawn on mount, respawn on crash/hang, terminate on unmount ---
  const spawnWorkerRef = useRef<() => void>(() => {})
  const dispatchCompileRef = useRef<() => void>(() => {})
  const consecutiveCrashesRef = useRef(0)
  spawnWorkerRef.current = () => {
    workerRef.current?.terminate()
    const worker = new CompilerWorker()
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<CompileResponse>) => {
      const { id, result, error, durationMs } = event.data

      // Discard stale results — a newer compile was dispatched
      if (id !== currentCompileId.current) return

      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current)
        watchdogRef.current = undefined
      }
      consecutiveCrashesRef.current = 0
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

      // Check if Fragment Output has any upstream connection
      const outputNode = nodesRef.current.find(n => n.data.type === 'fragment_output')
      const outputConnected = outputNode && edgesRef.current.some(e => e.target === outputNode.id)

      if (result?.success && outputConnected) {
        setShaders(result.vertexShader, result.fragmentShader)
        markCompileSuccess()
        // GLSL compiled but the WGSL/IR path failed — on a WebGPU renderer the
        // canvas silently keeps the previous shader, so surface it as an error
        // (markCompileSuccess above cleared the error list; set after).
        if (result.wgslError) {
          setErrors([{ message: result.wgslError, severity: 'error' as const }])
        }
        lastUniformsRef.current = result.userUniforms

        onCompileRef.current?.({
          success: true,
          fragmentShader: result.fragmentShader,
          userUniforms: result.userUniforms,
          isTimeLiveAtOutput: result.isTimeLiveAtOutput,
          qualityTier: result.qualityTier,
          passes: result.passes,
          wgsl: result.wgsl,
        })

        // Params may have moved while the compile was in flight — the plan
        // applied above baked dispatch-time values, so push the live ones.
        const live = collectCurrentUniformValues()
        if (live.length) onUniformUpdateRef.current?.(live)
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
      // A crashed worker never answers again — without a respawn every future
      // compile would silently go nowhere.
      console.error('[Sombra] Compiler worker crashed — respawning:', event.message, event)
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current)
        watchdogRef.current = undefined
      }
      currentCompileId.current = null
      consecutiveCrashesRef.current += 1
      spawnWorkerRef.current()

      if (consecutiveCrashesRef.current <= 1) {
        // Transient crash — retry the lost compile once on the fresh worker
        dispatchCompileRef.current()
      } else {
        // Crashed again without a successful response in between — the graph
        // itself likely kills the worker; stop retrying to avoid a crash loop.
        setErrors([
          {
            message: 'Shader compiler crashed repeatedly — this graph may trigger a compiler bug. Undo the last edit.',
            severity: 'error' as const,
          },
        ])
        setCompiling(false)
      }
    }
  }

  useEffect(() => {
    spawnWorkerRef.current()
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
      if (watchdogRef.current) clearTimeout(watchdogRef.current)
    }
  }, [])

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

  // Dispatch the current graph to the Worker. Shared by the semantic effect's
  // debounce timer and the crash-retry path; reassigned each render so it
  // always compiles the latest graph and records the latest semantic key.
  dispatchCompileRef.current = () => {
    const id = crypto.randomUUID()
    currentCompileId.current = id
    lastSemanticKeyRef.current = semanticKey
    workerRef.current?.postMessage({
      id,
      nodes: nodesRef.current,
      edges: edgesRef.current,
      useIR: useIR ?? false,
    })

    // Watchdog: a hung worker (runaway codegen) never errors and never
    // answers — without this the spinner sticks forever.
    if (watchdogRef.current) clearTimeout(watchdogRef.current)
    watchdogRef.current = setTimeout(() => {
      console.error('[Sombra] Compile timed out after 10s — restarting compiler worker')
      currentCompileId.current = null
      spawnWorkerRef.current()
      setErrors([
        {
          message: 'Shader compile timed out — compiler restarted. Undo the last edit.',
          severity: 'error' as const,
        },
      ])
      setCompiling(false)
    }, 10_000)
  }

  // --- Semantic effect: structural change → debounced Worker recompile ---
  useEffect(() => {
    if (!autoCompile) return

    if (semanticKey === lastSemanticKeyRef.current) {
      // Reverted to the already-dispatched graph (undo during debounce) — the
      // pending timer was cleared by this effect's own cleanup; drop the
      // spinner too or it sticks forever. (If a compile of this same key is
      // still in flight, its response re-clears — harmless.)
      setCompiling(false)
      return
    }

    setCompiling(true)

    // Dynamic debounce: clamp(lastDuration * 0.8, 50, 300)
    const delay = Math.min(300, Math.max(50, lastCompileDuration.current * 0.8))

    if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current)
    semanticTimerRef.current = setTimeout(() => {
      semanticTimerRef.current = undefined
      dispatchCompileRef.current()
    }, delay)

    return () => {
      if (semanticTimerRef.current) {
        clearTimeout(semanticTimerRef.current)
        semanticTimerRef.current = undefined
      }
    }
  }, [semanticKey, autoCompile, setCompiling])

  // --- Uniform effect: slider drag → fast-path upload, no recompile ---
  // Fixed short debounce: upload cost is trivial (no codegen), so tying it to
  // compile duration only made sliders laggy.
  useEffect(() => {
    if (!autoCompile) return

    if (uniformTimerRef.current) clearTimeout(uniformTimerRef.current)
    uniformTimerRef.current = setTimeout(() => {
      uniformTimerRef.current = undefined
      const values = collectCurrentUniformValues()
      if (values.length > 0) onUniformUpdateRef.current?.(values)
    }, 50)

    return () => {
      if (uniformTimerRef.current) {
        clearTimeout(uniformTimerRef.current)
        uniformTimerRef.current = undefined
      }
    }
  }, [uniformKey, autoCompile, collectCurrentUniformValues])

  // --- Renderer effect: quality/anchor change → direct renderer call ---
  // Unconditional on key change: the old combined effect skipped this branch
  // whenever a semantic change landed in the same pass, dropping the update.
  useEffect(() => {
    if (!autoCompile) return
    const outputNode = nodesRef.current.find((n) => n.data.type === 'fragment_output')
    const qualityTier = (outputNode?.data.params?.quality as string) ?? 'adaptive'
    const anchor = (outputNode?.data.params?.anchor as string) ?? 'center'
    // Flush uniforms in this SAME synchronous pass, cancelling the pending
    // debounce. An anchor change coupled with a uniform change (e.g. the pinned
    // gradient's p0/p1 compensation, committed atomically with the anchor) must
    // land in one frame — otherwise setAnchor applies now and the debounced
    // uniform push snaps in ~50ms later, a visible jump.
    if (uniformTimerRef.current) {
      clearTimeout(uniformTimerRef.current)
      uniformTimerRef.current = undefined
    }
    const values = collectCurrentUniformValues()
    if (values.length > 0) onUniformUpdateRef.current?.(values)
    onRendererUpdateRef.current?.({ qualityTier, anchor })
  }, [rendererKey, autoCompile, collectCurrentUniformValues])
}
