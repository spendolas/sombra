/**
 * PerfView — the in-app GPU/FPS profiler UI (Perf View, Task 4).
 *
 * Owns a <canvas> and one PerfSession. Subject / resolution / dpr / isolation
 * changes are pushed to the LIVE session via `session.update({...})` — the
 * session never restarts for those. Samples flow session → onSample → React
 * state → table.
 *
 * Backend is the ONE exception: a canvas's drawing-context type is fixed the
 * first time `getContext` succeeds, so a WebGPU canvas can never hand back a
 * WebGL2 context (getContext('webgl2') returns null → "WebGL2 not supported").
 * Switching backend therefore remounts a FRESH <canvas> and starts a fresh
 * PerfSession. That is exactly what the lifecycle effect is keyed on.
 *
 * Effect discipline (memory `effect-deps-value-not-identity`): the lifecycle
 * effect is keyed on the PRIMITIVE `config.backend`, never on a fresh config
 * object — so no re-create storm. The full config is read from a ref at start
 * time; the canvas is in the DOM before `start()` runs (PerfSession reads
 * clientWidth/Height).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PerfSession, type PerfConfig, type PerfSample } from '@/perf/perf-session'
import { useGraphStore } from '@/stores/graphStore'
import { nodeRegistry } from '@/nodes/registry'
import { ds } from '@/generated/ds'
import { PerfControls } from './PerfControls'
import { PerfMetricsTable } from './PerfMetricsTable'
import { RESOLUTIONS, type ResolutionOption, type NodeOption } from './perf-view-config'

const DEFAULT_CONFIG: PerfConfig = {
  subject: { kind: 'scene', sceneId: 'gaussian_r' },
  width: RESOLUTIONS[0].width,
  height: RESOLUTIONS[0].height,
  dpr: 1,
  backend: 'webgpu',
}

/**
 * Editor HUD default: the subject is FIXED to the live current graph (no
 * benchmark scenes in the editor), so isolation targets real nodes.
 */
const EDITOR_CONFIG: PerfConfig = {
  subject: { kind: 'live' },
  width: RESOLUTIONS[0].width,
  height: RESOLUTIONS[0].height,
  dpr: 1,
  backend: 'webgpu',
}

function subjectKey(subject: PerfConfig['subject']): string {
  return subject.kind === 'live' ? 'live' : subject.sceneId
}

/**
 * `standalone` (default) = the full profiler (scene picker, visible preview,
 * all controls) — used by the sandbox harness. `editor` = the slim live-graph
 * HUD mounted in the app under `?perf=1`: subject pinned to the live graph, no
 * scene picker, no visible preview canvas (the profiling canvas stays in the
 * DOM offscreen at its true render resolution so measurement stays honest).
 */
export type PerfViewMode = 'standalone' | 'editor'

export function PerfView({ mode = 'standalone' }: { mode?: PerfViewMode } = {}) {
  const editor = mode === 'editor'
  const initialConfig = editor ? EDITOR_CONFIG : DEFAULT_CONFIG

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<PerfSession | null>(null)

  const [config, setConfig] = useState<PerfConfig>(initialConfig)
  const [sample, setSample] = useState<PerfSample | null>(null)

  // The measured canvas keeps its true render-resolution CSS size (PerfSession
  // sets canvas.style to cfg.width×cfg.height so clientWidth → correct backing
  // store → honest measurement). CSS transforms do NOT change clientWidth, so we
  // display the whole frame by scaling a wrapper to fit the fixed preview box.
  // Recomputed on box resize (ResizeObserver) and whenever the resolution changes.
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState({ scale: 1, offsetY: 0 })

  useLayoutEffect(() => {
    const box = previewBoxRef.current
    if (!box) return
    const recompute = () => {
      const boxW = box.clientWidth
      const boxH = box.clientHeight
      if (boxW <= 0 || config.width <= 0) return
      const scale = boxW / config.width
      const scaledH = config.height * scale
      const offsetY = Math.max(0, (boxH - scaledH) / 2)
      setPreview({ scale, offsetY })
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(box)
    return () => ro.disconnect()
  }, [config.width, config.height])

  // The session's source of truth for the full config (the lifecycle effect
  // reads this at start time; it is not a render input, so it stays a ref).
  const configRef = useRef<PerfConfig>(initialConfig)

  // Node-isolation options: the current graph's nodes, id + node-type label.
  // Read reactively so live-graph edits refresh the list. Scenes have their own
  // synthetic ids; isolation targets whatever graph the session resolves, so we
  // list the live graph here (the practical case) — off is always available.
  const liveNodes = useGraphStore((s) => s.nodes)
  const nodeOptions: NodeOption[] = useMemo(
    () =>
      liveNodes.map((node) => {
        const nodeType = String((node.data as { type?: string })?.type ?? node.type ?? '')
        const label = nodeRegistry.get(nodeType)?.label ?? nodeType
        return { id: node.id, label: `${label} · ${node.id}` }
      }),
    [liveNodes],
  )

  // --- session lifecycle: (re)created per backend, disposed on unmount ------
  // Keyed on the primitive backend so a backend switch tears down and rebuilds
  // on the freshly-remounted <canvas> (canvas key below), while non-backend
  // changes flow through update() without touching this effect.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const session = new PerfSession(canvas)
    sessionRef.current = session
    session.onSample((s) => setSample(s))
    setSample(null)
    void session.start(configRef.current).catch((err) => {
      console.error('[PerfView] session.start failed:', err)
    })
    return () => {
      if (sessionRef.current === session) sessionRef.current = null
      session.dispose()
    }
  }, [config.backend])

  // --- control handlers -----------------------------------------------------
  function apply(partial: Partial<PerfConfig>) {
    const next = { ...configRef.current, ...partial }
    configRef.current = next
    setConfig(next)
    setSample(null) // measurement resets on the session side; clear the readout.
    // Backend changes are handled by the lifecycle effect (fresh canvas +
    // session); everything else is a live update on the current session.
    if (partial.backend === undefined) sessionRef.current?.update(partial)
  }

  return (
    <div className="flex flex-row gap-xl w-full h-full bg-surface text-fg overflow-hidden">
      {/* Left column: canvas + controls */}
      <div className={`${ds.propertiesPanel.root} w-[300px] shrink-0 overflow-y-auto`}>
        {editor ? (
          // Editor HUD: the app's own canvas already shows the graph output, so a
          // second preview is redundant. The profiling canvas MUST stay in the DOM
          // at its real cfg.width×cfg.height CSS size (PerfSession reads clientWidth
          // for the backing store) — hide it offscreen, NOT with display:none which
          // would zero clientWidth and break measurement.
          <canvas
            key={config.backend}
            ref={canvasRef}
            aria-hidden
            className="block"
            style={{
              position: 'absolute',
              left: -99999,
              top: 0,
              opacity: 0,
              pointerEvents: 'none',
              width: config.width,
              height: config.height,
            }}
          />
        ) : (
          <>
            <div className={ds.propertiesPanel.sectionHeader}>Preview</div>
            <div
              ref={previewBoxRef}
              className="relative aspect-video w-full overflow-hidden rounded-md border border-edge bg-surface-raised"
            >
              {/* Wrapper carries the scale-to-fit transform; the canvas inside keeps
                  its real cfg.width×cfg.height CSS size (set by PerfSession), so its
                  clientWidth stays honest while the whole frame is shown scaled down. */}
              <div
                className="absolute left-0 top-0"
                style={{
                  transform: `translateY(${preview.offsetY}px) scale(${preview.scale})`,
                  transformOrigin: 'top left',
                }}
              >
                <canvas
                  key={config.backend}
                  ref={canvasRef}
                  className="block"
                  style={{ width: config.width, height: config.height }}
                />
              </div>
            </div>
          </>
        )}

        <PerfControls
          showSubjectSelect={!editor}
          subjectKey={subjectKey(config.subject)}
          backend={config.backend}
          width={config.width}
          height={config.height}
          dpr={config.dpr}
          isolateNodeId={config.isolateNodeId}
          isolateDisabled={config.subject.kind !== 'live'}
          nodeOptions={nodeOptions}
          onSubjectChange={(subject) =>
            // Isolation is meaningless for a scene subject (its node ids differ
            // from the live graph the isolate list shows) and makes the
            // subgraph compiler throw, so drop it whenever we leave Live.
            apply(subject.kind === 'live' ? { subject } : { subject, isolateNodeId: undefined })
          }
          onBackendChange={(backend) => apply({ backend })}
          onResolutionChange={(r: ResolutionOption) => apply({ width: r.width, height: r.height })}
          onDprChange={(dpr) => apply({ dpr })}
          onIsolateChange={(isolateNodeId) => apply({ isolateNodeId })}
        />
      </div>

      {/* Right column: metrics */}
      <div className={`${ds.propertiesPanel.root} flex-1 overflow-y-auto`}>
        <div className="flex flex-row justify-between items-baseline">
          <span className={ds.propertiesPanel.nodeTitle}>Performance</span>
          <span className={ds.propertiesPanel.categoryMeta}>
            {config.backend} · {config.width}×{config.height} · dpr {config.dpr}
          </span>
        </div>
        <PerfMetricsTable sample={sample} />
      </div>
    </div>
  )
}

export default PerfView
