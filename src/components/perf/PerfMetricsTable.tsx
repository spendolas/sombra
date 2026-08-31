/**
 * PerfMetricsTable — read-only metrics readout for the Perf View (Task 4).
 *
 * Renders one `PerfSample` from a `PerfSession`: FPS + frame-ms percentiles, the
 * total GPU time, and a per-pass µs breakdown. Pure presentation — no session or
 * store access here; the parent owns the session and passes the latest sample.
 *
 * Formatting: GPU durations arrive in nanoseconds (WebGPU timestamp-query) and
 * are shown as µs (÷1000, 1 decimal). Frame times arrive in ms and are shown to
 * 2 decimals. When timing is `unavailable` (WebGL2 / no timestamp-query) the
 * per-pass section collapses to a single muted note — FPS still shows.
 */

import { ds } from '@/generated/ds'
import type { PerfSample } from '@/perf/perf-session'

const MONO = 'text-mono-value text-fg'

function fmtUs(ns: number): string {
  return `${(ns / 1000).toFixed(1)} µs`
}
function fmtMs(ms: number): string {
  return `${ms.toFixed(2)} ms`
}
function fmtFps(fps: number): string {
  return fps.toFixed(1)
}

/** One label→value row, built from the DS portRow bundle (two-column split). */
function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={ds.propertiesPanel.portRow}>
      <span className={ds.propertiesPanel.portLabel}>{label}</span>
      <span className={MONO}>{value}</span>
    </div>
  )
}

export function PerfMetricsTable({ sample }: { sample: PerfSample | null }) {
  if (!sample) {
    return (
      <div className={ds.propertiesPanel.paramSection}>
        <div className={ds.propertiesPanel.sectionHeader}>Metrics</div>
        <div className={ds.propertiesPanel.emptyText}>Warming up — waiting for the first sample…</div>
      </div>
    )
  }

  const timingAvailable = sample.timingMethod === 'timestamp-query'

  return (
    <div className="flex flex-col gap-lg">
      {/* Frame timings — always available (FPS is CPU-fenced). */}
      <div className={ds.propertiesPanel.paramSection}>
        <div className={ds.propertiesPanel.sectionHeader}>Frame</div>
        <div className={ds.propertiesPanel.portList}>
          <MetricRow label="FPS (p50)" value={fmtFps(sample.fps)} />
          <MetricRow label="Frame p50" value={fmtMs(sample.frameMsP50)} />
          <MetricRow label="Frame p95" value={fmtMs(sample.frameMsP95)} />
          <MetricRow label="Passes" value={String(sample.passCount)} />
        </div>
      </div>

      {/* GPU per-pass — WebGPU + timestamp-query only. */}
      <div className={ds.propertiesPanel.paramSection}>
        <div className="flex flex-row justify-between items-baseline">
          <span className={ds.propertiesPanel.sectionHeader}>GPU per-pass</span>
          <span className={ds.propertiesPanel.categoryMeta}>{sample.timingMethod}</span>
        </div>

        {!timingAvailable ? (
          <div className={ds.propertiesPanel.emptyText}>
            GPU per-pass timing unavailable (WebGL2 / no timestamp-query) — FPS only.
          </div>
        ) : (
          <div className={ds.propertiesPanel.portList}>
            <MetricRow
              label="GPU total"
              value={sample.gpuTotalNs != null ? fmtUs(sample.gpuTotalNs) : '—'}
            />
            {(sample.passNs ?? []).map((ns, i) => (
              <MetricRow key={i} label={`Pass ${i}`} value={fmtUs(ns)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Delivered-FPS row. The editor's render loop is THROTTLED to a target (30/45/
 *  60), so this reading is CAPPED at that target: a light graph reads the cap
 *  (not its true ceiling — that's the standalone benchmark's job), a heavy graph
 *  dips below it (the useful "can't hold target" signal). The target is shown
 *  alongside so a capped reading can't be mistaken for uncapped capability.
 *  `null` delivered = idle (static graph rendered then stopped) → shows `—`. */
function fmtDeliveredFps(deliveredFps: number | null, targetFps: number | null): string {
  const target = targetFps != null ? String(Math.round(targetFps)) : '—'
  if (deliveredFps == null) return `idle / ${target}`
  return `${Math.round(deliveredFps)} / ${target}`
}

/**
 * EditorPerfMetrics — the editor-HUD readout (Perf View editor mode).
 *
 * A PASSIVE reader of the editor's OWN renderer: no PerfSession. It leads with
 * the DELIVERED frame rate (Δframes/Δtime from the renderer's frame counter,
 * honestly labeled against the loop's throttle target — NOT the uncapped
 * benchmark FPS) and the real per-frame GPU cost of what's on screen, then lists
 * the per-pass breakdown. `passNs` comes straight from the live renderer's
 * `getPassTimingsNs()`, so its length IS the pass count the editor actually
 * renders. When timestamps are unavailable (WebGL2 editor / no timestamp-query)
 * the GPU section shows a muted note; delivered FPS still shows.
 */
export function EditorPerfMetrics({
  passNs,
  timingActive,
  deliveredFps,
  targetFps,
}: {
  passNs: number[] | null
  timingActive: boolean
  deliveredFps: number | null
  targetFps: number | null
}) {
  const gpuTotalNs = passNs ? passNs.reduce((a, b) => a + b, 0) : null

  return (
    <div className="flex flex-col gap-lg">
      {/* Delivered frame rate — capped at the loop's throttle target (shown). */}
      <div className={ds.propertiesPanel.paramSection}>
        <div className={ds.propertiesPanel.sectionHeader}>Frame rate</div>
        <div className={ds.propertiesPanel.portList}>
          <MetricRow
            label="FPS (delivered)"
            value={fmtDeliveredFps(deliveredFps, targetFps)}
          />
        </div>
      </div>

      {/* Headline: the real GPU cost of the frame the user is looking at. */}
      {!timingActive ? (
        <div className={ds.propertiesPanel.paramSection}>
          <div className={ds.propertiesPanel.sectionHeader}>GPU / frame</div>
          <div className={ds.propertiesPanel.emptyText}>
            GPU per-pass timing unavailable (WebGL2 / no timestamp-query).
          </div>
        </div>
      ) : (
        <>
      <div className={ds.propertiesPanel.paramSection}>
        <div className={ds.propertiesPanel.sectionHeader}>GPU / frame</div>
        <div className={ds.propertiesPanel.portList}>
          <MetricRow label="GPU total" value={gpuTotalNs != null ? fmtUs(gpuTotalNs) : '—'} />
        </div>
      </div>

      {/* Per-pass breakdown of the editor's actual on-screen render. */}
      <div className={ds.propertiesPanel.paramSection}>
        <div className="flex flex-row justify-between items-baseline">
          <span className={ds.propertiesPanel.sectionHeader}>Per-pass</span>
          <span className={ds.propertiesPanel.categoryMeta}>
            {passNs?.length ?? 0} {(passNs?.length ?? 0) === 1 ? 'pass' : 'passes'}
          </span>
        </div>
        {passNs && passNs.length > 0 ? (
          <div className={ds.propertiesPanel.portList}>
            {passNs.map((ns, i) => (
              <MetricRow key={i} label={`Pass ${i}`} value={fmtUs(ns)} />
            ))}
          </div>
        ) : (
          <div className={ds.propertiesPanel.emptyText}>Waiting for the first rendered frame…</div>
        )}
      </div>
        </>
      )}
    </div>
  )
}
