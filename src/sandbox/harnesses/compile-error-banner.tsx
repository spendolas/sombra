/**
 * Compile-error banner.
 *
 * Reads `compilerStore.errors` rather than props, so the fixture here is the store.
 * The cases that matter are the ones that broke the old banner: a renderer rejection
 * (long, no nodeId, unreachable anywhere else in the UI) and several errors at once.
 *
 * Rendered over a busy backdrop — a glass surface over a flat panel looks identical
 * to an unblurred one, so a flat harness would prove nothing.
 */

import { useEffect, useState } from 'react'
import { CompileErrorBanner } from '@/components/CompileErrorBanner'
import { useCompilerStore } from '@/stores/compilerStore'
import { cn } from '@/lib/utils'

type Case = { label: string; messages: string[] }

const CASES: Case[] = [
  {
    label: 'Renderer rejection (the one that was unreadable)',
    messages: [
      'Renderer rejected shader: Graph needs 9 intermediate render targets (max 8) — reduce effect chain depth',
    ],
  },
  {
    label: 'Single node error',
    messages: ["Noise: parameter 'scale' has no connection and no default"],
  },
  {
    label: 'Several at once',
    messages: [
      "Noise: parameter 'scale' has no connection and no default",
      'Blur: source must be connected for a multi-pass effect',
      'Fragment Output: color input is required',
      'Stack: layer_2 is wired but never read',
    ],
  },
  { label: 'No errors (renders nothing)', messages: [] },
]

export default function CompileErrorBannerHarness() {
  const [caseIndex, setCaseIndex] = useState(0)
  const [animate, setAnimate] = useState(true)

  useEffect(() => {
    useCompilerStore.setState({
      errors: CASES[caseIndex].messages.map((message) => ({
        message,
        severity: 'error' as const,
      })),
    })
  }, [caseIndex])

  return (
    <div className="flex flex-col gap-xl p-xl bg-surface min-h-screen text-fg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-node-title">Compile Error Banner</h1>
        <p className="text-param text-fg-subtle max-w-[46rem]">
          Click the banner to expand. It collapses again whenever the error set
          changes, so a stale expansion cannot hide a fresh failure.
        </p>
        <div className="flex flex-wrap gap-sm">
          {CASES.map((c, i) => (
            <button
              key={c.label}
              onClick={() => setCaseIndex(i)}
              className={cn(
                'text-param px-md py-xs rounded-sm border border-edge cursor-pointer',
                i === caseIndex ? 'bg-surface-elevated text-fg' : 'bg-surface-alt text-fg-dim',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-sm text-param text-fg-dim">
          <input type="checkbox" checked={animate} onChange={(e) => setAnimate(e.target.checked)} />
          Animate the backdrop (proves the blur samples live content)
        </label>
      </div>

      <div className="relative h-[320px] w-full overflow-hidden rounded-md">
        <div
          className={cn('absolute inset-0', animate && 'motion-safe:animate-[spin_20s_linear_infinite]')}
          style={{
            background:
              'conic-gradient(from 0deg, #6366f1, #34d399, #fbbf24, #ef4444, #6366f1)',
          }}
        />
        {/* The banner positions itself absolutely, exactly as it does in the preview panel. */}
        <CompileErrorBanner />
      </div>
    </div>
  )
}
