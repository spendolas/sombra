/**
 * DebugBandPanel — TEMPORARY dev-only tool for chasing the faint GPU
 * compositor tile-banding. Renders a fixed control strip (portaled to <body>
 * so it stays unfiltered) that applies a shadow-lift filter to #root, so the
 * sub-perceptual band becomes visible, plus layer-hide toggles to bisect which
 * surface tiles. Slider values persist in localStorage across reloads.
 *
 * Gated to import.meta.env.DEV — never ships. Delete this file + its mount in
 * App.tsx when the banding investigation is done.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const LS = 'sombra-debug-band'
type Saved = { brightness: number; contrast: number; saturate: number; filterOn: boolean }
const DEFAULTS: Saved = { brightness: 4.8, contrast: 5.45, saturate: 0.1, filterOn: true }

function load(): Saved {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS) || '{}') } } catch { return DEFAULTS }
}

const wrap: React.CSSProperties = {
  position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647,
  background: '#0b0b12', color: '#e8e8f0', font: '11px/1.35 ui-monospace,monospace',
  padding: '10px 14px', border: '1px solid #3a3a52', borderRadius: 10,
  display: 'flex', gap: 14, alignItems: 'flex-end', boxShadow: '0 8px 30px rgba(0,0,0,.6)', userSelect: 'none',
}
const btn = (on: boolean): React.CSSProperties => ({
  cursor: 'pointer', background: on ? '#6366f1' : '#252538', color: '#e8e8f0',
  border: '1px solid #3a3a52', borderRadius: 6, padding: '5px 9px', font: 'inherit',
})

function Slider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span>{label} <b style={{ color: '#818cf8' }}>{value}</b></span>
      <input type="range" min={min} max={max} step={step} value={value}
        style={{ width: 120, accentColor: '#6366f1' }}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  )
}

/** Best-effort DOM hide for a bisect toggle (React Flow layers aren't React-remounted often). */
function useDomHide(selector: string | (() => Element | null), hidden: boolean, prop: 'display' | 'visibility' = 'visibility') {
  useEffect(() => {
    const el = typeof selector === 'function' ? selector() : document.querySelector(selector)
    if (!(el instanceof HTMLElement)) return
    el.style[prop] = hidden ? (prop === 'display' ? 'none' : 'hidden') : ''
    return () => { if (el instanceof HTMLElement) el.style[prop] = '' }
  }, [selector, hidden, prop])
}

export function DebugBandPanel() {
  const init = load()
  const [brightness, setBrightness] = useState(init.brightness)
  const [contrast, setContrast] = useState(init.contrast)
  const [saturate, setSaturate] = useState(init.saturate)
  const [filterOn, setFilterOn] = useState(init.filterOn)
  const [hideOverlay, setHideOverlay] = useState(false)
  const [hideBg, setHideBg] = useState(false)
  const [hideCanvas, setHideCanvas] = useState(false)
  const [hideViewport, setHideViewport] = useState(false)

  useEffect(() => {
    const root = document.getElementById('root')
    if (!root) return
    root.style.filter = filterOn ? `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})` : ''
    localStorage.setItem(LS, JSON.stringify({ brightness, contrast, saturate, filterOn }))
    return () => { root.style.filter = '' }
  }, [brightness, contrast, saturate, filterOn])

  const overlayEl = () =>
    [...document.querySelectorAll('.react-flow__panel')].find(
      (p) => (p.getAttribute('class') || '').includes('flex-col') && p.querySelector('svg'),
    ) ?? null
  const mainCanvas = () =>
    [...document.querySelectorAll('canvas')].find((c) => !(c.width === 80 && c.height === 80)) ?? null

  useDomHide(overlayEl, hideOverlay, 'display')
  useDomHide('.react-flow__background', hideBg, 'display')
  useDomHide(mainCanvas, hideCanvas)
  useDomHide('.react-flow__viewport', hideViewport)

  return createPortal(
    <div style={wrap}>
      <Slider label="Brightness" value={brightness} min={1} max={10} step={0.1} onChange={setBrightness} />
      <Slider label="Contrast" value={contrast} min={1} max={15} step={0.05} onChange={setContrast} />
      <Slider label="Saturate" value={saturate} min={0} max={4} step={0.1} onChange={setSaturate} />
      <button style={btn(hideOverlay)} onClick={() => setHideOverlay((v) => !v)}>Nodes overlay</button>
      <button style={btn(hideBg)} onClick={() => setHideBg((v) => !v)}>RF bg</button>
      <button style={btn(hideCanvas)} onClick={() => setHideCanvas((v) => !v)}>Preview canvas</button>
      <button style={btn(hideViewport)} onClick={() => setHideViewport((v) => !v)}>Viewport</button>
      <button style={btn(!filterOn)} onClick={() => setFilterOn((v) => !v)}>{filterOn ? 'Filter on' : 'Filter off'}</button>
    </div>,
    document.body,
  )
}
