/**
 * SegmentedControlSandbox — local dev harness for the SegmentedControl prototype
 * (the Offset Space Screen|Local control). View at /segmented-control-sandbox.html
 * on the dev server. Not shipped. Renders the REAL component from NodeParameters
 * on real DS tokens, standalone and in the node Transform-section context, so the
 * look can be signed off before it's wired into ShaderNode.
 */

import { useState } from 'react'
import { SegmentedControl } from '@/components/NodeParameters'
import type { NodeParameter } from '@/nodes/types'

const offsetSpaceParam: NodeParameter = {
  id: 'srt_translateSpace',
  label: 'Offset Space',
  type: 'enum',
  default: 'screen',
  control: 'segmented',
  updateMode: 'recompile',
  options: [
    { value: 'screen', label: 'Screen' },
    { value: 'local', label: 'Local' },
  ],
}

const threeWayParam: NodeParameter = {
  id: 'demo3',
  label: 'Wrap Mode',
  type: 'enum',
  default: 'clamp',
  control: 'segmented',
  updateMode: 'recompile',
  options: [
    { value: 'clamp', label: 'Clamp' },
    { value: 'repeat', label: 'Repeat' },
    { value: 'mirror', label: 'Mirror' },
  ],
}

// Faux slider row so the Transform section reads like the real node body.
function FakeSlider({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col pl-handle-offset pr-xs gap-xs">
      <div className="flex items-baseline justify-between">
        <span className="text-param text-fg-dim">{label}</span>
        <span className="text-mono-value text-fg tabular-nums">{value}</span>
      </div>
      <div className="h-1 rounded-full bg-surface-raised">
        <div className="h-full w-1/2 rounded-full bg-indigo" />
      </div>
    </div>
  )
}

export function SegmentedControlSandbox() {
  const [space, setSpace] = useState('screen')
  const [wrap, setWrap] = useState('clamp')

  return (
    <div className="min-h-screen bg-surface text-fg p-2xl" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div className="max-w-[860px] mx-auto">
        <p className="text-[11px] tracking-[0.14em] uppercase text-fg-muted font-semibold mb-1">Sombra · Design Sandbox</p>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          Segmented Control
          <span className="ml-2 align-middle text-[10px] tracking-wider uppercase font-bold text-indigo-hover border border-indigo px-1.5 py-0.5 rounded-full">Prototype</span>
        </h1>
        <p className="text-fg-subtle mt-1 max-w-[62ch]">
          For small fixed enums (2–3 options) where seeing every choice beats a dropdown. Lives in{' '}
          <code className="text-fg-dim">NodeParameters.tsx</code> as <code className="text-fg-dim">SegmentedControl</code>,
          selected via <code className="text-fg-dim">control: 'segmented'</code>. Once signed off it replaces the Offset Space dropdown and goes into the Figma DS.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2xl mt-2xl items-start">
          {/* Standalone states */}
          <div className="flex flex-col gap-xl">
            <p className="text-[11px] tracking-[0.1em] uppercase text-fg-muted font-semibold">Standalone</p>

            <div className="w-[280px] bg-surface-elevated border border-edge-card rounded-md p-md">
              <SegmentedControl param={offsetSpaceParam} value={space} onChange={setSpace} />
              <p className="text-[11px] text-fg-muted mt-sm">value: <code className="text-fg-dim">{space}</code></p>
            </div>

            <div className="w-[280px] bg-surface-elevated border border-edge-card rounded-md p-md">
              <SegmentedControl param={threeWayParam} value={wrap} onChange={setWrap} />
              <p className="text-[11px] text-fg-muted mt-sm">3-option variant · value: <code className="text-fg-dim">{wrap}</code></p>
            </div>
          </div>

          {/* In the node Transform-section context */}
          <div className="flex flex-col gap-xl">
            <p className="text-[11px] tracking-[0.1em] uppercase text-fg-muted font-semibold">In the node Transform section</p>
            <div className="w-[280px] bg-surface-elevated border border-edge-card rounded-md overflow-hidden">
              <div className="bg-surface-raised px-md py-sm text-body font-medium border-b border-edge-subtle">Stripes</div>
              <div className="flex flex-col gap-md p-md">
                <div className="pt-xs">
                  <div className="px-sm pb-2xs text-fg-subtle" style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Transform</div>
                  <div className="flex flex-col gap-md">
                    <FakeSlider label="Scale" value="2.00" />
                    <FakeSlider label="Rotate" value="0" />
                    <FakeSlider label="Offset X" value="120" />
                    <FakeSlider label="Offset Y" value="0" />
                    <div className="pl-handle-offset pr-xs">
                      <SegmentedControl param={offsetSpaceParam} value={space} onChange={setSpace} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
