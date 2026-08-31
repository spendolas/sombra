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
