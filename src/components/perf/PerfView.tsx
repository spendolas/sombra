/**
 * PerfView — the in-app GPU profiler UI (Perf View).
 *
 * Two modes, two very different jobs:
 *
 * - `standalone` (default; the sandbox harness `?c=perf-view`): the full
 *   independent benchmark. Owns a <canvas> and one PerfSession, compiles a
 *   subject graph (live / scene / isolated node), and drives an UNCAPPED render
 *   loop at a chosen resolution/backend/dpr. Scene picker, visible preview, all
 *   controls. Unchanged.
 *
 * - `editor` (the app's dev-only `?perf=1` HUD): a PASSIVE reader of the
 *   EDITOR'S OWN on-screen renderer. It creates NOTHING — no PerfSession, no
 *   second canvas, no second GPUDevice, no render loop. It polls the live main
 *   `ShaderRenderer` (passed in as a prop) for per-pass GPU timings and shows the
 *   real cost of what's on screen at the editor's actual backing resolution.
 *   There is only ONE device, so no cross-device resource fight.
 *
 * Backend note (standalone): a canvas's drawing-context type is fixed the first
 * time `getContext` succeeds, so switching backend remounts a FRESH <canvas> and
 * starts a fresh PerfSession — exactly what the lifecycle effect is keyed on.
 *
 * Effect discipline (memory `effect-deps-value-not-identity`): the standalone
 * lifecycle effect is keyed on the PRIMITIVE `config.backend`, never a fresh
 * config object; the editor poll effect is keyed on the `renderer` identity.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PerfSession, type PerfConfig, type PerfSample } from '@/perf/perf-session'
import { useGraphStore } from '@/stores/graphStore'
import { usePreviewStore } from '@/stores/previewStore'
import { nodeRegistry } from '@/nodes/registry'
import type { ShaderRenderer } from '@/renderer/types'
import { ds } from '@/generated/ds'
import { PerfControls } from './PerfControls'
import { PerfMetricsTable, EditorPerfMetrics } from './PerfMetricsTable'
import { RESOLUTIONS, type ResolutionOption, type NodeOption } from './perf-view-config'

const DEFAULT_CONFIG: PerfConfig = {
  subject: { kind: 'scene', sceneId: 'gaussian_r' },
  width: RESOLUTIONS[0].width,
  height: RESOLUTIONS[0].height,
  dpr: 1,
  backend: 'webgpu',
}

function subjectKey(subject: PerfConfig['subject']): string {
  return subject.kind === 'live' ? 'live' : subject.sceneId
}

/**
 * `standalone` (default) = the full profiler (scene picker, visible preview, all
 * controls) — used by the sandbox harness. `editor` = the slim live HUD mounted
 * in the app under `?perf=1`: a passive reader of the editor's own renderer.
 */
export type PerfViewMode = 'standalone' | 'editor'

export function PerfView({
  mode = 'standalone',
  renderer,
}: {
  mode?: PerfViewMode
  renderer?: ShaderRenderer | null
} = {}) {
  return mode === 'editor' ? (
    <EditorPerfView renderer={renderer ?? null} />
  ) : (
    <StandalonePerfView />
  )
}

// ---------------------------------------------------------------------------
// Editor HUD — passive reader of the editor's actual on-screen renderer.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 250

function EditorPerfView({ renderer }: { renderer: ShaderRenderer | null }) {
  const [passNs, setPassNs] = useState<number[] | null>(null)
  const [timingActive, setTimingActive] = useState(false)
  // Delivered FPS derived from the renderer's frame counter. `null` = idle (no
  // frames produced over the last window — a static graph rendered on demand
  // then stopped), which the readout shows as `—`, never 0.
  const [deliveredFps, setDeliveredFps] = useState<number | null>(null)
  const [targetFps, setTargetFps] = useState<number | null>(null)

  // The editor's REAL backing resolution (device px) — App feeds it here from the
  // main canvas ResizeObserver. Read-only display, never a control.
  const [mainW, mainH] = usePreviewStore((s) => s.mainCanvasSize)

  // Poll the passed renderer — no render loop of our own; the editor already
  // renders. getPassTimingsNs() returns the most recent readback (cached), so
  // this is cheap and reflects the last on-screen frame; it refreshes whenever
  // the graph is edited and the editor re-renders. The frame counter is sampled
  // the same way: Δframes / Δseconds over the poll window = DELIVERED FPS, which
  // is capped at the loop's target (heavy graph dips below; light graph reads the
  // cap, not its true ceiling — that's the standalone benchmark's job).
  useEffect(() => {
    if (!renderer) {
      setPassNs(null)
      setTimingActive(false)
      setDeliveredFps(null)
      setTargetFps(null)
      return
    }
    // Previous (frameCount, timestamp) sample and a short EMA for light smoothing.
    let prevFrames = renderer.getFrameCount?.() ?? null
    let prevTime = performance.now()
    let ema: number | null = null
    const poll = () => {
      setPassNs(renderer.getPassTimingsNs?.() ?? null)
      setTimingActive(renderer.timestampsActive?.() ?? false)
      setTargetFps(renderer.getTargetFps?.() ?? null)

      const frames = renderer.getFrameCount?.()
      const now = performance.now()
      if (frames == null || prevFrames == null) {
        // Backend without a counter — leave delivered FPS unknown (shows —).
        setDeliveredFps(null)
        prevFrames = frames ?? null
        prevTime = now
        return
      }
      const dFrames = frames - prevFrames
      const dSeconds = (now - prevTime) / 1000
      prevFrames = frames
      prevTime = now
      if (dFrames <= 0 || dSeconds <= 0) {
        // No frames this window → idle. Reset the EMA so the next active reading
        // starts clean rather than blending across an idle gap.
        ema = null
        setDeliveredFps(null)
        return
      }
      const instant = dFrames / dSeconds
      ema = ema == null ? instant : ema * 0.5 + instant * 0.5
      setDeliveredFps(ema)
    }
    poll()
    const id = setInterval(poll, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [renderer])

  const resolutionText = renderer
    ? `${mainW}×${mainH} · ${renderer.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}`
    : '—'

  return (
    <div className={`${ds.propertiesPanel.root} w-full h-full overflow-y-auto bg-surface text-fg`}>
      <div className="flex flex-row justify-between items-baseline">
        <span className={ds.propertiesPanel.nodeTitle}>Performance</span>
        <span className={ds.propertiesPanel.categoryMeta}>{resolutionText}</span>
      </div>
      <div className={ds.propertiesPanel.categoryMeta}>Editor's actual on-screen render</div>

      {!renderer ? (
        <div className={ds.propertiesPanel.emptyText}>Waiting for renderer…</div>
      ) : (
        <EditorPerfMetrics
          passNs={passNs}
          timingActive={timingActive}
          deliveredFps={deliveredFps}
          targetFps={targetFps}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Standalone profiler — the full independent benchmark (sandbox harness).
// ---------------------------------------------------------------------------

function StandalonePerfView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<PerfSession | null>(null)

  const [config, setConfig] = useState<PerfConfig>(DEFAULT_CONFIG)
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
  const configRef = useRef<PerfConfig>(DEFAULT_CONFIG)

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

        <PerfControls
          showSubjectSelect
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
