/**
 * ColorPickerSandbox — local dev harness for the RgbaColorPicker prototype.
 * View at /color-picker-sandbox.html on the dev server. Not shipped.
 */

import { useState } from 'react'
import { RgbaColorPicker, type Rgba } from '@/components/RgbaColorPicker'

const CHECKER: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg,#2a2a3e 25%,transparent 25%),linear-gradient(-45deg,#2a2a3e 25%,transparent 25%),' +
    'linear-gradient(45deg,transparent 75%,#2a2a3e 75%),linear-gradient(-45deg,transparent 75%,#2a2a3e 75%)',
  backgroundSize: '16px 16px', backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
}

function Seg({ value, options, onChange }: { value: string; options: Array<{ v: string; label: string }>; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex bg-surface-alt border border-edge rounded-md p-0.5">
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)}
          className={`text-[12px] px-3 py-1.5 rounded-sm cursor-pointer transition-colors ${value === o.v ? 'bg-indigo text-white' : 'text-fg-subtle hover:text-fg-dim'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ColorPickerSandbox() {
  const [color, setColor] = useState<Rgba>([0.42, 0.86, 0.17, 1])
  const [placement, setPlacement] = useState<'popover' | 'inline'>('popover')
  const [showAlpha, setShowAlpha] = useState(true)
  const [swatchIcon, setSwatchIcon] = useState<'none' | 'pipette'>('none')

  const [r, g, b, a] = color
  const to255 = (x: number) => Math.round(x * 255)
  const hex = '#' + [r, g, b].map((x) => ('0' + to255(x).toString(16)).slice(-2)).join('').toUpperCase()

  return (
    <div className="min-h-screen bg-surface text-fg p-2xl" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div className="max-w-[860px] mx-auto">
        <p className="text-[11px] tracking-[0.14em] uppercase text-fg-muted font-semibold mb-1">Sombra · Design Sandbox</p>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          Color Picker <span className="ml-2 align-middle text-[10px] tracking-wider uppercase font-bold text-indigo-hover border border-indigo px-1.5 py-0.5 rounded-full">Prototype</span>
        </h1>
        <p className="text-fg-subtle mt-1 max-w-[62ch]">Coolors-style picker as real React on Sombra DS tokens + the owned DS icon set. The footer menu swaps the whole body (HEX ↔ RGB/HSB/HSL). Lives in <code className="text-fg-dim">RgbaColorPicker.tsx</code> until sign-off, then replaces <code className="text-fg-dim">RgbaColorPicker</code>.</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2xl mt-2xl items-start">
          <div>
            <p className="text-[11px] tracking-[0.1em] uppercase text-fg-muted font-semibold mb-2">Harness</p>
            <div className="flex flex-wrap gap-xl mb-xl">
              <label className="flex flex-col gap-1.5"><span className="text-[11px] text-fg-subtle">Mode</span>
                <Seg value={placement} onChange={(v) => setPlacement(v as 'popover' | 'inline')} options={[{ v: 'popover', label: 'Popover' }, { v: 'inline', label: 'Inline' }]} />
              </label>
              <label className="flex flex-col gap-1.5"><span className="text-[11px] text-fg-subtle">Alpha</span>
                <Seg value={showAlpha ? 'on' : 'off'} onChange={(v) => setShowAlpha(v === 'on')} options={[{ v: 'on', label: 'On' }, { v: 'off', label: 'Off' }]} />
              </label>
              <label className="flex flex-col gap-1.5"><span className="text-[11px] text-fg-subtle">Trigger icon <span className="text-fg-muted">(matte case)</span></span>
                <Seg value={swatchIcon} onChange={(v) => setSwatchIcon(v as 'none' | 'pipette')} options={[{ v: 'none', label: 'None' }, { v: 'pipette', label: 'Pipette' }]} />
              </label>
            </div>

            <div className={`rounded-md p-2xl min-h-[320px] flex items-start justify-center ${placement === 'inline' ? 'bg-surface-alt border border-edge' : 'bg-surface border border-dashed border-edge-subtle'}`}>
              {placement === 'inline' ? (
                <div className="w-[232px]">
                  <div className="flex items-center justify-between pb-md mb-md border-b border-edge-subtle"><span className="text-[12px] text-fg-subtle">Color</span></div>
                  <RgbaColorPicker value={color} onChange={setColor} mode="inline" showAlpha={showAlpha} />
                </div>
              ) : (
                <RgbaColorPicker value={color} onChange={setColor} mode="popover" showAlpha={showAlpha} triggerIcon={swatchIcon === 'pipette' ? 'pipette' : undefined} />
              )}
            </div>
          </div>

          <div>
            <p className="text-[11px] tracking-[0.1em] uppercase text-fg-muted font-semibold mb-2">Live output</p>
            <div className="h-[120px] rounded-md border border-edge overflow-hidden relative" style={CHECKER}>
              <div className="absolute inset-0" style={{ background: `rgba(${to255(r)},${to255(g)},${to255(b)},${a})` }} />
            </div>
            <dl className="mt-lg grid grid-cols-[auto_1fr] gap-x-lg gap-y-sm text-mono-value">
              <dt className="text-[11px] uppercase tracking-wide text-fg-muted">Hex</dt><dd className="m-0 text-fg-dim">{hex}{showAlpha ? ` · a ${a.toFixed(2)}` : ''}</dd>
              <dt className="text-[11px] uppercase tracking-wide text-fg-muted">RGBA</dt><dd className="m-0 text-fg-dim">{to255(r)}, {to255(g)}, {to255(b)}{showAlpha ? `, ${a.toFixed(2)}` : ''}</dd>
            </dl>
            <div className="mt-2xl p-lg bg-surface-alt border border-edge-subtle rounded-md text-[12.5px] text-fg-subtle">
              <b className="text-fg-dim font-semibold">Now real DS:</b> tokens via Tailwind utilities, icons via <code className="text-fg-dim">icons.ts</code> (owned, vendored). Sliders are custom pointer-capture (pen-safe). Eyedropper shows on Chromium only.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
