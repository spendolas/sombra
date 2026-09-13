/**
 * AMD see-through warning — the glass pill.
 *
 * The component takes no props: it reads `rendererStore.isAmd` and
 * `settingsStore.previewBackground/previewMode` and renders nothing unless all
 * of them line up. That makes it nearly impossible to see in the real app on
 * demand (you need an AMD GPU, WebGPU, see-through mode AND a floating preview),
 * which is exactly what a harness is for — the stores are the fixture here.
 *
 * It is also a glass surface, so it is only judgeable over moving content. The
 * backdrop below is deliberately busy: a flat panel would hide whether the blur
 * works at all.
 */

import { useEffect, useState } from 'react'
import { AmdSeeThroughWarning } from '@/components/AmdSeeThroughWarning'
import { useRendererStore } from '@/stores/rendererStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'

export default function AmdWarningHarness() {
  const [animate, setAnimate] = useState(true)
  const [ready, setReady] = useState(false)

  // Fixture: put the stores into the only state that renders the pill.
  useEffect(() => {
    useRendererStore.setState({ isAmd: true })
    useSettingsStore.setState({
      previewMode: 'floating',
      previewBackground: { mode: 'none', color: '#1a1a2e' },
    } as Partial<ReturnType<typeof useSettingsStore.getState>>)
    setReady(true)
  }, [])

  return (
    <div className="flex flex-col gap-xl p-xl bg-surface min-h-screen text-fg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-node-title">AMD See-Through Warning</h1>
        <p className="text-param text-fg-subtle max-w-[46rem]">
          Hover the pill to expand it; it auto-collapses. Classes come from{' '}
          <code className="text-fg-dim">ds.amdWarning.*</code> — pill{' '}
          <code className="text-fg-dim">{ds.amdWarning.pill}</code>.
        </p>
        <label className="flex items-center gap-sm text-param text-fg-dim">
          <input
            type="checkbox"
            checked={animate}
            onChange={(e) => setAnimate(e.target.checked)}
          />
          Animate the backdrop (proves the blur is sampling live content)
        </label>
      </div>

      {/* Busy, moving backdrop — a glass surface cannot be judged over a flat one. */}
      <div className="relative h-[220px] w-full overflow-hidden rounded-md">
        <div
          className={cn(
            'absolute inset-0',
            animate && 'motion-safe:animate-[spin_18s_linear_infinite]',
          )}
          style={{
            background:
              'conic-gradient(from 0deg, #6366f1, #fbbf24, #34d399, #f472b6, #6366f1)',
            filter: 'saturate(1.2)',
          }}
        />
        <div className="absolute inset-0 flex items-start gap-lg p-lg">
          {ready && <AmdSeeThroughWarning />}
        </div>
      </div>

      {/* Same pill over a flat surface, for contrast: this is what an in-node
          placement would look like, and why the blur is not worth paying for there. */}
      <div className="relative h-[120px] w-full overflow-hidden rounded-md bg-surface-elevated">
        <div className="absolute inset-0 flex items-start gap-lg p-lg">
          {ready && <AmdSeeThroughWarning />}
        </div>
      </div>
      <p className="text-param text-fg-muted max-w-[46rem]">
        Over the flat surface the blur buys nothing — the argument for keeping
        in-node chrome on a solid fill.
      </p>
    </div>
  )
}
