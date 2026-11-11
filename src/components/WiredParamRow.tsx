/**
 * WiredParamRow — what a connectable parameter's row shows while a wire drives it.
 *
 * Designed in Figma first: component set "Wired Param Row" (998:6114, the Option D
 * variants), the hover instance 999:7576 and "Wired Tooltip" (999:6115), on the
 * board "Wired param display — options" (999:6139). The owner chose Option D,
 * "Live indicator". Styled entirely from `ds.wiredParamRow`.
 *
 * What the design settled, enforced here:
 *  - Same height as the unwired row it replaces; the handle stays where it was.
 *    Line one: label, `← Source.output`, and the value the param actually gets.
 *    Line two: where the slider track was, an indicator of how that value behaves.
 *  - Constant source: the exact number and a tick on the track.
 *    Time-driven source: the current number and a sparkline of recent values
 *    ending in a "now" dot.
 *    Per-pixel source: "varies"; with a known min/max, the range as text and a
 *    min–max bar on the track.
 *  - Colour params: the colour as swatch + hex + a solid strip (alpha shown over
 *    a checkerboard); per-pixel colour: a struck-out swatch, "varies" and a strip
 *    of sampled colours.
 *  - Mask (Stack layer): the 20px labelled-port row, with a small range bar.
 *  - Hover (or keyboard focus): a faint row tint and the tooltip
 *    "Driven by Node.output. / Disconnect to edit.". The row has no editable
 *    control: no input, slider or button.
 *  - Reduced motion: the sparkline is drawn once and not redrawn; the number
 *    still updates (text changing in place is not motion).
 *
 * Pure: no store and no React Flow. The values arrive as props — the editor's
 * wiring decides where they come from and how often (see the wiki's plug-in
 * plan). The handle is a slot, so the real node passes its React Flow handle.
 */

import { useEffect, useId, useState, type CSSProperties, type FocusEvent, type ReactNode } from 'react'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { CHECKER_STYLE } from '@/components/ColorSwatch'

export type WiredKind = 'float' | 'color' | 'mask' | 'opacity'
export type WiredRgba = [number, number, number, number]

export type WiredValue =
  /** One exact value: a Number / Color node, or a chain the editor could evaluate. */
  | { mode: 'constant'; value: number | WiredRgba }
  /** One value that changes over time; `history` is oldest → newest (the last ~2 s). */
  | { mode: 'animated'; value: number; history: number[] }
  /** No single value. `min`/`max` (floats) or `palette` (CSS colours) when known. */
  | { mode: 'varies'; min?: number; max?: number; palette?: string[] }

export interface WiredSource {
  /** The driving node's label ("Number"). */
  node: string
  /** Its output ("value"). */
  output: string
}

export interface WiredParamRowProps {
  /** The param's label ("Scale"). */
  label: string
  kind: WiredKind
  source: WiredSource
  value: WiredValue
  /** The param's slider range, used to place the tick and the range bar. Default [0, 1]. */
  range?: [number, number]
  /** Number formatting for the value and the range text. Default: two decimals. */
  formatValue?: (v: number) => string
  /** The row's handle (the real node passes its React Flow handle). */
  handle?: ReactNode
  /** Second tooltip line. */
  hint?: string
  /** Controlled tooltip (and hover tint). Undefined = pointer hover / keyboard focus. */
  tooltipOpen?: boolean
  className?: string
}

const defaultFormat = (v: number) => v.toFixed(2)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const to255 = (x: number) => Math.round(clamp01(x) * 255)
const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/** "#RRGGBB", or "#RRGGBBAA" when the colour is not opaque. */
function wiredHex([r, g, b, a]: WiredRgba): string {
  const s = '#' + hex2(to255(r)) + hex2(to255(g)) + hex2(to255(b)) + (a < 1 ? hex2(to255(a)) : '')
  return s.toUpperCase()
}
const rgbaCss = ([r, g, b, a]: WiredRgba) => `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${clamp01(a)})`
/** The colour as a solid layer over the swatch checkerboard, in one background. */
const stripStyle = (c: WiredRgba): CSSProperties => ({
  backgroundImage: `linear-gradient(${rgbaCss(c)}, ${rgbaCss(c)}), ${CHECKER_STYLE.backgroundImage}`,
  backgroundSize: `auto, ${CHECKER_STYLE.backgroundSize}`,
  backgroundPosition: `0 0, ${CHECKER_STYLE.backgroundPosition}`,
})
const asRgba = (v: number | WiredRgba): WiredRgba => (Array.isArray(v) ? v : [v, v, v, 1])
const asNumber = (v: number | WiredRgba): number => (Array.isArray(v) ? v[0] : v)

/** True while the user asks for reduced motion; follows changes live. */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

// ── Sparkline ────────────────────────────────────────────────────────────────
// Figma: a 162px line in a 168px slot (the rest is room for the "now" dot),
// 1.25px indigo-hover stroke, auto-fitted to the window's own min/max.
const SPARK_W = 162 / 168 // fraction of the slot the line spans
const SPARK_H = 16 // indicator height (px)
const SPARK_PAD = 2.5 // keep the stroke and the dot inside the slot

function sparkPoints(history: number[]): { points: string; endX: number; endY: number } {
  const n = history.length
  if (n === 0) return { points: '', endX: 0, endY: SPARK_H / 2 }
  let lo = Infinity, hi = -Infinity
  for (const v of history) { if (v < lo) lo = v; if (v > hi) hi = v }
  const span = hi - lo
  const y = (v: number) => (span > 1e-9 ? SPARK_PAD + (1 - (v - lo) / span) * (SPARK_H - 2 * SPARK_PAD) : SPARK_H / 2)
  const x = (i: number) => (n === 1 ? SPARK_W : (i / (n - 1)) * SPARK_W) * 100
  const pts: string[] = []
  for (let i = 0; i < n; i++) pts.push(`${x(i).toFixed(2)},${y(history[i]).toFixed(2)}`)
  return { points: pts.join(' '), endX: x(n - 1), endY: y(history[n - 1]) }
}

function Sparkline({ history, frozen }: { history: number[]; frozen: boolean }) {
  // Reduced motion: keep the history seen when it froze and never redraw.
  // (State adjusted during render — React's pattern for deriving from a prop change.)
  const [snapshot, setSnapshot] = useState<number[] | null>(frozen ? history : null)
  if (frozen && snapshot === null) setSnapshot(history)
  if (!frozen && snapshot !== null) setSnapshot(null)
  const shown = frozen ? (snapshot ?? history) : history
  const { points, endX, endY } = sparkPoints(shown)
  return (
    <>
      <svg
        className={ds.wiredParamRow.sparkline}
        viewBox={`0 0 100 ${SPARK_H}`}
        preserveAspectRatio="none"
        aria-hidden
        data-part="sparkline"
        data-frozen={frozen ? 'true' : undefined}
        data-points={shown.length}
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {shown.length > 0 && (
        <span
          className={ds.wiredParamRow.nowDot}
          style={{ left: `${endX}%`, top: endY }}
          data-part="now"
        />
      )}
    </>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────

export function WiredParamRow({
  label,
  kind,
  source,
  value,
  range = [0, 1],
  formatValue = defaultFormat,
  handle,
  hint = 'Disconnect to edit.',
  tooltipOpen,
  className,
}: WiredParamRowProps) {
  const reducedMotion = useReducedMotion()
  const [hovered, setHovered] = useState(false)
  const [keyboardFocus, setKeyboardFocus] = useState(false)
  const showTip = tooltipOpen ?? (hovered || keyboardFocus)
  const tipId = useId()

  const [rMin, rMax] = range
  const frac = (v: number) => (rMax === rMin ? 0 : clamp01((v - rMin) / (rMax - rMin)))
  const pct = (v: number) => `${frac(v) * 100}%`
  const sourceText = `← ${source.node}.${source.output}`
  const isColor = kind === 'color'

  // ── value text + indicator, by kind × mode ──
  let valueNode: ReactNode
  let indicator: ReactNode
  let spoken: string

  if (value.mode === 'constant') {
    if (isColor) {
      const c = asRgba(value.value)
      const hex = wiredHex(c)
      spoken = hex
      valueNode = (
        <span className={ds.wiredParamRow.valueGroupColor}>
          <span className={ds.wiredParamRow.swatch} style={CHECKER_STYLE} data-part="swatch">
            <span className="absolute inset-0" style={{ background: rgbaCss(c) }} data-part="swatch-fill" />
          </span>
          <span className={ds.wiredParamRow.value} data-part="value">{hex}</span>
        </span>
      )
      indicator = <span className={ds.wiredParamRow.colorStrip} style={stripStyle(c)} data-part="strip" />
    } else {
      const v = asNumber(value.value)
      spoken = formatValue(v)
      valueNode = (
        <span className={ds.wiredParamRow.valueGroup}>
          <span className={ds.wiredParamRow.value} data-part="value">{formatValue(v)}</span>
        </span>
      )
      indicator = (
        <>
          <span className={ds.wiredParamRow.track} />
          <span className={ds.wiredParamRow.tick} style={{ left: pct(v) }} data-part="tick" />
        </>
      )
    }
  } else if (value.mode === 'animated') {
    spoken = formatValue(value.value)
    valueNode = (
      <span className={ds.wiredParamRow.valueGroup}>
        <span className={ds.wiredParamRow.value} data-part="value">{formatValue(value.value)}</span>
      </span>
    )
    indicator = (
      <>
        <span className={ds.wiredParamRow.trackDim} />
        <Sparkline history={value.history} frozen={reducedMotion} />
      </>
    )
  } else {
    const hasRange = !isColor && value.min != null && value.max != null
    const rangeText = hasRange ? `${formatValue(value.min!)}–${formatValue(value.max!)}` : null
    spoken = rangeText ? `varies, ${rangeText}` : 'varies'
    valueNode = isColor ? (
      <span className={ds.wiredParamRow.valueGroupColor}>
        <span className={ds.wiredParamRow.swatchNone} data-part="swatch-none">
          <span className={ds.wiredParamRow.swatchSlash} />
        </span>
        <span className={ds.wiredParamRow.valueMuted} data-part="value">varies</span>
      </span>
    ) : (
      <span className={ds.wiredParamRow.valueGroup}>
        <span className={ds.wiredParamRow.valueMuted} data-part="value" aria-label={spoken}>{rangeText ?? 'varies'}</span>
      </span>
    )
    if (isColor) {
      const palette = value.palette ?? []
      indicator = palette.length > 0 ? (
        <span className={ds.wiredParamRow.palette} data-part="palette">
          {palette.map((c, i) => (
            <span key={i} className={ds.wiredParamRow.paletteSample} style={{ backgroundColor: c }} data-part="sample" />
          ))}
        </span>
      ) : (
        <span className={ds.wiredParamRow.track} />
      )
    } else {
      indicator = (
        <>
          <span className={ds.wiredParamRow.track} />
          {hasRange && (
            <>
              <span
                className={ds.wiredParamRow.rangeBar}
                style={{ left: pct(Math.min(value.min!, value.max!)), width: `${Math.abs(frac(value.max!) - frac(value.min!)) * 100}%` }}
                data-part="range"
              />
              <span className={ds.wiredParamRow.rangeEnd} style={{ left: pct(value.min!) }} data-part="range-min" />
              <span className={ds.wiredParamRow.rangeEnd} style={{ left: pct(value.max!) }} data-part="range-max" />
            </>
          )}
        </>
      )
    }
  }

  // ── tooltip trigger (the only focusable thing on the row) ──
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    let visible = true
    try { visible = e.currentTarget.matches(':focus-visible') } catch { /* old engines */ }
    setKeyboardFocus(visible)
  }
  const triggerProps = {
    tabIndex: 0,
    role: 'group' as const,
    'aria-label': `${label} ${sourceText}: ${spoken}`,
    'aria-describedby': showTip ? tipId : undefined,
    'data-wired': kind,
    'data-mode': value.mode,
    'data-hover': showTip ? 'true' : undefined,
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
    onFocus,
    onBlur: () => setKeyboardFocus(false),
  }

  const tooltip = showTip && (
    <div id={tipId} role="tooltip" className={ds.wiredParamRow.tooltip}>
      <span className={ds.wiredParamRow.tooltipMessage}>Driven by {source.node}.{source.output}.</span>
      {hint && <span className={ds.wiredParamRow.tooltipHint}>{hint}</span>}
    </div>
  )

  if (kind === 'mask') {
    const hasRange = value.mode === 'varies' && value.min != null && value.max != null
    const lo = hasRange ? clamp01(Math.min(value.min!, value.max!)) : 0
    const hi = hasRange ? clamp01(Math.max(value.min!, value.max!)) : 0
    return (
      <div className={cn(showTip ? ds.wiredParamRow.rootHover : ds.wiredParamRow.maskRoot, className)} {...triggerProps}>
        {handle}
        <div className={ds.wiredParamRow.maskContent}>
          <span className={ds.wiredParamRow.maskLabel}>{label}</span>
          <span className={ds.wiredParamRow.source} title={sourceText}>{sourceText}</span>
          <span className={ds.wiredParamRow.maskRange}>
            <span className={ds.wiredParamRow.maskRangeTrack} />
            {hasRange && (
              <span className={ds.wiredParamRow.maskRangeFill} style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} data-part="range" />
            )}
          </span>
        </div>
        {tooltip}
      </div>
    )
  }

  return (
    <div className={cn(showTip ? ds.wiredParamRow.rootHover : ds.wiredParamRow.root, className)} {...triggerProps}>
      {handle}
      <div className={ds.wiredParamRow.content}>
        <div className={ds.wiredParamRow.labelLine}>
          <span className={ds.wiredParamRow.label}>{label}</span>
          <span className={ds.wiredParamRow.source} title={sourceText}>{sourceText}</span>
          {valueNode}
        </div>
        <div className={ds.wiredParamRow.indicator} data-part="indicator">{indicator}</div>
      </div>
      {tooltip}
    </div>
  )
}
