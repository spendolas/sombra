/**
 * RgbaColorPicker — Coolors-style colour picker on Sombra DS tokens + the owned
 * DS icon set. The footer menu switches the whole body:
 *  - HEX  : 2D saturation/value area + hue slider + editable hex + swatch
 *  - RGB / HSB / HSL : three (or four with alpha) labelled channel sliders, each
 *    with a live gradient track + editable value.
 *
 * Controlled: value/onChange are normalized [r,g,b,a] floats (0-1). Sliders are
 * custom pointer-capture (pen-safe) — never a native <input type=range>. All
 * chrome comes from `ds.colorPicker.*` (Figma component set "Color Picker").
 */

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'
import { icons, type IconName } from '@/components/icons'
import { ColorSwatch } from '@/components/ColorSwatch'
import { IconButton } from '@/components/IconButton'

export type Rgba = [number, number, number, number]
type View = 'hex' | 'rgb' | 'hsb' | 'hsl'
interface Hsv { h: number; s: number; v: number }

const ChevronIcon = icons.chevronDown
const CheckIcon = icons.check

const VIEW_ORDER: Array<{ v: View; label: string }> = [
  { v: 'hex', label: 'HEX' }, { v: 'hsb', label: 'HSB' }, { v: 'hsl', label: 'HSL' }, { v: 'rgb', label: 'RGB' },
]
const VIEW_LABEL: Record<View, string> = { hex: 'HEX', rgb: 'RGB', hsb: 'HSB', hsl: 'HSL' }

// ── color math ──
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
function rgbToHsv(r: number, g: number, b: number): Hsv {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d !== 0) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360 }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx }
}
function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x]
  return [r + m, g + m, b + m]
}
function hsvToHsl(h: number, s: number, v: number) { const l = v * (1 - s / 2), m = Math.min(l, 1 - l); return { h, s: m === 0 ? 0 : (v - l) / m, l } }
function hslToHsv(h: number, s: number, l: number): Hsv { const v = l + s * Math.min(l, 1 - l); return { h, s: v === 0 ? 0 : 2 * (1 - l / v), v } }
function hslToRgb(h: number, s: number, l: number) { return hsvToRgb(hslToHsv(h, s, l)) }
const to255 = (x: number) => Math.round(x * 255)
const hex2 = (n: number) => ('0' + n.toString(16)).slice(-2)
const rgbStr = (rgb: number[]) => `rgb(${to255(rgb[0])},${to255(rgb[1])},${to255(rgb[2])})`
const rgbaCss = (r: number, g: number, b: number, a: number) => `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${a})`
// Alpha thumb fill: fade the colour toward the checker's lightest cell as alpha
// → 0, so the thumb represents the opacity it sets (matches the track's
// transparent end). Light cell = the grey checker square over surface-raised.
const CHECKER_LIGHT: [number, number, number] = [73, 73, 85]
function alphaHandleFill(r: number, g: number, b: number, a: number) {
  const mix = (c: number, l: number) => Math.round(to255(c) * a + l * (1 - a))
  return `rgb(${mix(r, CHECKER_LIGHT[0])}, ${mix(g, CHECKER_LIGHT[1])}, ${mix(b, CHECKER_LIGHT[2])})`
}
function toHex(rgb: number[], a: number, withAlpha: boolean) {
  let s = '#' + hex2(to255(rgb[0])) + hex2(to255(rgb[1])) + hex2(to255(rgb[2]))
  if (withAlpha) s += hex2(to255(a))
  return s.toUpperCase()
}
function parseHex(str: string) {
  const s = str.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]+$/.test(s)) return null
  let r: number, g: number, b: number, a = 1
  if (s.length === 3) { r = parseInt(s[0] + s[0], 16); g = parseInt(s[1] + s[1], 16); b = parseInt(s[2] + s[2], 16) }
  else if (s.length === 6) { r = parseInt(s.slice(0, 2), 16); g = parseInt(s.slice(2, 4), 16); b = parseInt(s.slice(4, 6), 16) }
  else if (s.length === 8) { r = parseInt(s.slice(0, 2), 16); g = parseInt(s.slice(2, 4), 16); b = parseInt(s.slice(4, 6), 16); a = parseInt(s.slice(6, 8), 16) / 255 }
  else return null
  return { r: r / 255, g: g / 255, b: b / 255, a }
}
function valuesEqual(a: Rgba, b: Rgba) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] }

// checker tiles (behind alpha / transparent swatches)
const CHECKER =
  'linear-gradient(45deg,rgba(128,128,128,.4) 25%,transparent 25%),' +
  'linear-gradient(-45deg,rgba(128,128,128,.4) 25%,transparent 25%),' +
  'linear-gradient(45deg,transparent 75%,rgba(128,128,128,.4) 75%),' +
  'linear-gradient(-45deg,transparent 75%,rgba(128,128,128,.4) 75%)'
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage: CHECKER, backgroundSize: '8px 8px', backgroundPosition: '0 0,0 4px,4px -4px,-4px 0',
}
const HUE_GRAD = 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'
const RING_SHADOW = '0 0 0 1.5px rgba(0,0,0,.4), 0 1px 4px rgba(0,0,0,.5)'

// ── custom pointer-capture slider (pen-safe; see slider rule) ──
function TrackSlider({ value, onChange, style, className, ariaLabel, handleColor }: {
  value: number; onChange: (frac: number) => void; style?: React.CSSProperties; className?: string; ariaLabel?: string; handleColor?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef(onChange); cb.current = onChange
  const fracFromX = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return value
    return clamp01((clientX - rect.left) / rect.width)
  }
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* already released */ }
    cb.current(fracFromX(e.clientX))
    const mv = (ev: PointerEvent) => cb.current(fracFromX(ev.clientX))
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }
  return (
    <div ref={ref} role="slider" aria-label={ariaLabel} aria-valuenow={Math.round(value * 100)}
      className={cn(ds.colorPicker.slider, className)}
      style={style} onPointerDown={onPointerDown}>
      <div className={cn(ds.colorPicker.handle, 'top-1/2 w-4 h-4 -translate-x-1/2 -translate-y-1/2')}
        style={{ left: `${value * 100}%`, boxShadow: RING_SHADOW, background: handleColor }} />
    </div>
  )
}

// ── channel descriptor for RGB/HSB/HSL views ──
interface ChannelSpec { label: string; max: number; frac: number; disp: number; set: (frac: number) => Hsv; alpha?: boolean; track?: string }
function channelSpec(key: string, hsv: Hsv): ChannelSpec {
  const rgb = hsvToRgb(hsv), [r, g, b] = rgb
  const hsl = hsvToHsl(hsv.h, hsv.s, hsv.v)
  switch (key) {
    case 'r': return { label: 'Red', max: 255, frac: r, disp: to255(r), set: (f) => rgbToHsv(f, g, b), track: `linear-gradient(to right,${rgbStr([0, g, b])},${rgbStr([1, g, b])})` }
    case 'g': return { label: 'Green', max: 255, frac: g, disp: to255(g), set: (f) => rgbToHsv(r, f, b), track: `linear-gradient(to right,${rgbStr([r, 0, b])},${rgbStr([r, 1, b])})` }
    case 'b': return { label: 'Blue', max: 255, frac: b, disp: to255(b), set: (f) => rgbToHsv(r, g, f), track: `linear-gradient(to right,${rgbStr([r, g, 0])},${rgbStr([r, g, 1])})` }
    case 'H': return { label: 'Hue', max: 360, frac: hsv.h / 360, disp: Math.round(hsv.h), set: (f) => ({ ...hsv, h: f * 360 }), track: HUE_GRAD }
    case 'Sb': return { label: 'Saturation', max: 100, frac: hsv.s, disp: Math.round(hsv.s * 100), set: (f) => ({ ...hsv, s: f }), track: `linear-gradient(to right,${rgbStr(hsvToRgb({ ...hsv, s: 0 }))},${rgbStr(hsvToRgb({ ...hsv, s: 1 }))})` }
    case 'Bv': return { label: 'Brightness', max: 100, frac: hsv.v, disp: Math.round(hsv.v * 100), set: (f) => ({ ...hsv, v: f }), track: `linear-gradient(to right,#000,${rgbStr(hsvToRgb({ ...hsv, v: 1 }))})` }
    case 'Sl': return { label: 'Saturation', max: 100, frac: hsl.s, disp: Math.round(hsl.s * 100), set: (f) => hslToHsv(hsv.h, f, hsl.l), track: `linear-gradient(to right,${rgbStr(hslToRgb(hsv.h, 0, hsl.l))},${rgbStr(hslToRgb(hsv.h, 1, hsl.l))})` }
    case 'Ll': return { label: 'Luminance', max: 100, frac: hsl.l, disp: Math.round(hsl.l * 100), set: (f) => hslToHsv(hsv.h, hsl.s, f), track: `linear-gradient(to right,#000,${rgbStr(hslToRgb(hsv.h, hsl.s, 0.5))},#fff)` }
    default: return { label: 'Alpha', max: 100, frac: 0, disp: 0, set: () => hsv, alpha: true }
  }
}
function viewKeys(view: View, showAlpha: boolean): string[] {
  const base = view === 'rgb' ? ['r', 'g', 'b'] : view === 'hsb' ? ['H', 'Sb', 'Bv'] : ['H', 'Sl', 'Ll']
  return showAlpha ? base.concat(['A']) : base
}

const VIEWPORT_MARGIN = 8
const TRIGGER_GAP = 4

interface Props {
  value: Rgba
  onChange: (v: Rgba) => void
  mode?: 'inline' | 'popover'
  showAlpha?: boolean
  label?: string
  className?: string
  /** optional icon overlaid on the popover trigger swatch (e.g. 'pipette' for the export matte) */
  triggerIcon?: IconName
}

export function RgbaColorPicker({ value, onChange, mode = 'popover', showAlpha = true, label, className, triggerIcon }: Props) {
  const inline = mode === 'inline'
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(value[0], value[1], value[2]))
  const [view, setView] = useState<View>('hex')
  const [open, setOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const colorInputRef = useRef<HTMLInputElement>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEmitted = useRef<Rgba>(value)

  const a = showAlpha ? value[3] : 1
  const rgb = hsvToRgb(hsv)
  const [r, g, b] = rgb

  // Resync from external value changes (undo/redo, load), never our own echoes.
  // Keyed on the numeric value, not the array identity — consumers often pass a
  // fresh array every render (e.g. the color node body), and depending on
  // identity re-ran this effect (and its setHsv) every frame → 2x re-render.
  const valueKey = value.join(',')
  useEffect(() => {
    if (!valuesEqual(value, lastEmitted.current)) { setHsv(rgbToHsv(value[0], value[1], value[2])); lastEmitted.current = value }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey])

  const emit = useCallback((next: Hsv, alpha: number) => {
    const [nr, ng, nb] = hsvToRgb(next)
    const out: Rgba = [nr, ng, nb, alpha]
    lastEmitted.current = out
    onChange(out)
  }, [onChange])

  const commit = useCallback((next: Hsv, alpha = a) => { setHsv(next); emit(next, alpha) }, [a, emit])

  // ── popover open + viewport clamp ──
  const openPopover = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect(); if (!rect) return
    setPos({ top: rect.bottom + TRIGGER_GAP, left: rect.left }); setOpen(true)
  }, [])
  useLayoutEffect(() => {
    if (inline || !open) return
    const t = triggerRef.current, p = popoverRef.current; if (!t || !p) return
    const tr = t.getBoundingClientRect(), pr = p.getBoundingClientRect()
    let top = tr.bottom + TRIGGER_GAP
    if (top + pr.height > window.innerHeight - VIEWPORT_MARGIN) {
      const above = tr.top - TRIGGER_GAP - pr.height
      top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - pr.height)
    }
    let left = tr.left
    if (left + pr.width > window.innerWidth - VIEWPORT_MARGIN) left = window.innerWidth - VIEWPORT_MARGIN - pr.width
    left = Math.max(VIEWPORT_MARGIN, left)
    setPos({ top, left })
  }, [inline, open])
  useEffect(() => {
    if (inline || !open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if ((!rootRef.current || !rootRef.current.contains(t)) && (!popoverRef.current || !popoverRef.current.contains(t))) { setOpen(false); setMenuOpen(false) }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setMenuOpen(false) } }
    window.addEventListener('pointerdown', onDown); window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [inline, open])

  // ── SV drag ──
  const onSvPointer = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* already released */ }
    const rect = svRef.current?.getBoundingClientRect(); if (!rect) return
    const update = (x: number, y: number) => commit({ ...hsv, s: clamp01((x - rect.left) / rect.width), v: clamp01(1 - (y - rect.top) / rect.height) })
    update(e.clientX, e.clientY)
    const mv = (ev: PointerEvent) => update(ev.clientX, ev.clientY)
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
  }, [hsv, commit])

  // Pick a colour from the screen. EyeDropper is a pure screen-pick but is
  // Chromium-only. Elsewhere (Safari 16+, Firefox) drive the hidden native
  // <input type="color"> via showPicker(): it opens the OS colour panel, which on
  // macOS carries its own system eyedropper (the magnifier). Either way alpha is
  // kept. NB the input stays pointer-events-none — Safari won't shrink a color
  // input below its intrinsic size, so an interactive overlay bleeds onto the
  // neighbouring button; letting the button drive showPicker() avoids that.
  const pickFromScreen = useCallback(() => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (ED) {
      new ED().open().then((res) => { const p = parseHex(res.sRGBHex); if (p) commit(rgbToHsv(p.r, p.g, p.b)) }).catch(() => { /* cancelled */ })
      return
    }
    const el = colorInputRef.current
    if (!el) return
    try { el.showPicker() } catch { el.click() }
  }, [commit])

  const formattedValue = useCallback(() => {
    if (view === 'hex') return toHex(rgb, a, showAlpha)
    if (view === 'rgb') return `${showAlpha ? 'rgba(' : 'rgb('}${to255(r)}, ${to255(g)}, ${to255(b)}${showAlpha ? `, ${a.toFixed(2)}` : ''})`
    if (view === 'hsb') return `hsb(${Math.round(hsv.h)}, ${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%${showAlpha ? `, ${a.toFixed(2)}` : ''})`
    const hsl = hsvToHsl(hsv.h, hsv.s, hsv.v)
    return `hsl(${Math.round(hsl.h)}, ${Math.round(hsl.s * 100)}%, ${Math.round(hsl.l * 100)}%${showAlpha ? `, ${a.toFixed(2)}` : ''})`
  }, [view, rgb, a, r, g, b, hsv, showAlpha])
  const copyValue = useCallback(() => {
    const text = formattedValue()
    if (!navigator.clipboard?.writeText) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1400)
    }).catch(() => {})
  }, [formattedValue])
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])

  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window
  // showPicker() lets non-Chromium browsers open the native OS colour panel.
  const hasColorInputPicker = typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype
  const canPickFromScreen = hasEyeDropper || hasColorInputPicker
  const pickTitle = hasEyeDropper ? 'Pick from screen' : 'Pick from screen (system colour picker)'
  const alphaTrackStyle: React.CSSProperties = {
    backgroundImage: `linear-gradient(to right,${rgbaCss(r, g, b, 0)},${rgbaCss(r, g, b, 1)}),` + CHECKER,
    backgroundSize: '100% 100%,8px 8px,8px 8px,8px 8px,8px 8px',
    backgroundPosition: '0 0,0 0,0 4px,4px -4px,-4px 0',
    backgroundRepeat: 'no-repeat,repeat,repeat,repeat,repeat',
  }

  // ── body per view ──
  const body = view === 'hex' ? (
    <>
      <div ref={svRef} className={ds.colorPicker.svArea} onPointerDown={onSvPointer}>
        <div className={ds.colorPicker.svFill}
          style={{ backgroundColor: `hsl(${hsv.h},100%,50%)`, backgroundImage: 'linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent)' }} />
        <div className={cn(ds.colorPicker.handle, 'w-[18px] h-[18px] -translate-x-1/2 -translate-y-1/2')}
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, boxShadow: RING_SHADOW, background: rgbaCss(r, g, b, 1) }} />
      </div>
      <TrackSlider ariaLabel="Hue" value={hsv.h / 360} onChange={(f) => commit({ ...hsv, h: f * 360 })} style={{ background: HUE_GRAD }} handleColor={rgbaCss(r, g, b, 1)} />
      {showAlpha && <TrackSlider ariaLabel="Alpha" value={a} onChange={(f) => commit(hsv, f)} style={alphaTrackStyle} handleColor={alphaHandleFill(r, g, b, a)} />}
      <div className={ds.colorPicker.inputRow}>
        <input type="text" spellCheck={false} aria-label="Hex value"
          value={hexDraft ?? toHex(rgb, a, showAlpha)}
          onFocus={() => setHexDraft(toHex(rgb, a, showAlpha))}
          onChange={(e) => { setHexDraft(e.target.value); const p = parseHex(e.target.value); if (p) commit(rgbToHsv(p.r, p.g, p.b), showAlpha ? p.a : 1) }}
          onBlur={() => setHexDraft(null)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className={ds.colorPicker.hexInput} />
        <div className="relative flex-none w-8 h-8 rounded-md border border-edge overflow-hidden" style={CHECKER_STYLE} aria-hidden>
          <span className="absolute inset-0" style={{ background: rgbaCss(r, g, b, a) }} />
        </div>
      </div>
    </>
  ) : (
    <div className={ds.colorPicker.channels}>
      {viewKeys(view, showAlpha).map((key) => {
        const spec = channelSpec(key, hsv)
        const style: React.CSSProperties = spec.alpha ? alphaTrackStyle : { background: spec.track }
        const frac = spec.alpha ? a : spec.frac
        const disp = spec.alpha ? Math.round(a * 100) : spec.disp
        return (
          <div key={key} className={ds.colorPicker.channelRow}>
            <div className={ds.colorPicker.channelHead}>
              <span className={ds.colorPicker.channelLabel}>{spec.label}</span>
              <input type="number" min={0} max={spec.max} value={disp} aria-label={spec.label}
                onChange={(e) => { const n = parseFloat(e.target.value); if (isNaN(n)) return; const f = clamp01(n / spec.max); if (spec.alpha) commit(hsv, f); else commit(spec.set(f)) }}
                className={ds.colorPicker.channelValue} />
            </div>
            <TrackSlider ariaLabel={spec.label} value={frac} onChange={(f) => { if (spec.alpha) commit(hsv, f); else commit(spec.set(f)) }} style={style} handleColor={spec.alpha ? alphaHandleFill(r, g, b, a) : rgbaCss(r, g, b, 1)} />
          </div>
        )
      })}
    </div>
  )

  const footer = (
    <div className={ds.colorPicker.footer}>
      <button type="button" aria-haspopup="true" aria-expanded={menuOpen} onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}
        className={ds.colorPicker.formTrigger}>
        {VIEW_LABEL[view]}
        <ChevronIcon className={cn('w-3.5 h-3.5 transition-transform', menuOpen && 'rotate-180')} />
      </button>
      <div className="flex gap-xs">
        {canPickFromScreen && (
          <span className="relative inline-flex">
            <IconButton icon="pipette" onClick={pickFromScreen} aria-label="Pick color from screen" title={pickTitle} />
            {/* Safari/Firefox fallback: hidden native colour input the button drives
                via showPicker(). inset-0 so the popover anchors near the swatch, but
                pointer-events-none so it never intercepts clicks meant for other
                buttons (Safari won't shrink it below its intrinsic size). #rrggbb
                only → alpha preserved via commit. */}
            {!hasEyeDropper && hasColorInputPicker && (
              <input
                ref={colorInputRef}
                type="color"
                value={toHex(rgb, 1, false).toLowerCase()}
                onChange={(e) => { const p = parseHex(e.target.value); if (p) commit(rgbToHsv(p.r, p.g, p.b)) }}
                aria-hidden
                tabIndex={-1}
                className="absolute inset-0 opacity-0 pointer-events-none"
              />
            )}
          </span>
        )}
        <IconButton icon={copied ? 'check' : 'copy'} iconClassName={copied ? 'text-success' : undefined} onClick={copyValue} aria-label="Copy value" title={copied ? 'Copied' : 'Copy value'} />
      </div>
      {menuOpen && (
        <div className={ds.colorPicker.menu}>
          {VIEW_ORDER.map((o) => {
            const sel = o.v === view
            return (
              <button key={o.v} type="button" aria-selected={sel} onClick={(e) => { e.stopPropagation(); setView(o.v); setMenuOpen(false) }}
                className={cn(ds.colorPicker.menuItem, sel ? ds.colorPicker.menuItemActive : ds.colorPicker.menuItemIdle)}>
                {o.label}
                <CheckIcon className={cn('w-[15px] h-[15px]', !sel && 'invisible')} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )

  const panelInner = (
    <>
      <div className={ds.colorPicker.body}>{body}</div>
      {footer}
    </>
  )

  return (
    <div ref={rootRef} className={cn('relative nodrag nowheel', inline ? 'w-full' : 'w-fit', className)}>
      {label && <label className="text-param text-fg-subtle">{label}</label>}

      {inline ? (
        <div className={cn(ds.colorPicker.body, 'w-full')}>{panelInner}</div>
      ) : (
        <ColorSwatch ref={triggerRef} value={[r, g, b, a]} icon={triggerIcon}
          onClick={() => (open ? setOpen(false) : openPopover())} aria-label={label ?? 'Color'} />
      )}

      {!inline && open && pos && createPortal(
        <div ref={popoverRef} className={cn(ds.colorPicker.panel, 'fixed z-[1000]')}
          style={{ top: pos.top, left: pos.left }} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
          {panelInner}
        </div>,
        document.body,
      )}
    </div>
  )
}
