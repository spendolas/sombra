/**
 * KnobTable — the published knobs of a scene, as a host will address them.
 *
 * Designed in Figma on the board "Embed modal — knob table" (993:3778); the rows
 * are the Knob Row set (994:4106) under the Table Header (994:4033). It lives in
 * the Embed modal's "Control it from JavaScript" section, under the snippet.
 *
 * Presentational and pure: the caller hands it knobs; it reads no store.
 *
 *   - Named knobs first (in the order given), a thin divider, then the
 *     auto-named rest with slightly dimmer keys.
 *   - The body stops at about eleven rows and scrolls under a header that is
 *     outside the scroll box, so it cannot scroll away.
 *   - Clicking a row copies its KEY (nothing else): copy icon after the key on
 *     hover; afterwards a green check and "Copied" for 1.5 s, the same icons and
 *     timing as the Embed modal's snippet copy buttons.
 *   - A name clash shows as a calm notice above the table plus a small amber
 *     mark on the numbered row.
 */

import { useEffect, useRef, useState } from 'react'
import type { KnobDescriptor } from '@/embed/artifact'
import { icons } from '@/components/icons'
import { Separator } from '@/components/ui/separator'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'

/**
 * One row. The first five fields are KnobDescriptor's own; `named` is being
 * added to KnobDescriptor on another branch, and the clash fields come from the
 * manifest's dedupe pass, so they are declared here until both land.
 */
export type KnobTableItem = Pick<KnobDescriptor, 'key' | 'type' | 'default' | 'min' | 'max'> & {
  /** The owning node carries a name the author gave it: listed first, full-strength key. */
  named?: boolean
  /** This key was numbered because another node has the same name. */
  clash?: boolean
  /** Text beside the clash mark. Default: "name clash, numbered". */
  clashNote?: string
}

export interface KnobTableProps {
  knobs: KnobTableItem[]
  /** Copy a key. Default: the system clipboard (with a fallback for older browsers). */
  onCopy?: (key: string) => void | Promise<void>
  /** Shown above the table, e.g. which name clashed and the key it produced. */
  notice?: string
  /** One line under the table. */
  footnote?: string
  /** How long "Copied" stays up, in ms. */
  copiedMs?: number
  className?: string
}

export const COPIED_MS = 1500
const DEFAULT_CLASH_NOTE = 'name clash, numbered'
export const EMPTY_TEXT = 'This scene has no knobs: hosts can show it, but there is nothing to drive.'

const MINUS = '−'

/** Numbers as an author reads them: integers bare, fractions to ≤4 places, a real minus sign. */
function formatKnobNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const s = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)))
  return s === '-0' ? '0' : s.replace(/^-/, MINUS)
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** [r, g, b, a?] floats → { hex: '#RRGGBB', alpha } */
function knobColor(value: number | number[]): { hex: string; alpha: number; rgba: string } {
  const v = Array.isArray(value) ? value : [value, value, value]
  const [r = 0, g = 0, b = 0] = v.map(clamp01)
  const alpha = v.length > 3 ? clamp01(v[3]) : 1
  const to255 = (x: number) => Math.round(x * 255)
  const hex = '#' + [r, g, b].map((x) => to255(x).toString(16).padStart(2, '0')).join('').toUpperCase()
  return { hex, alpha, rgba: `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha})` }
}

function formatKnobRange(k: Pick<KnobTableItem, 'min' | 'max'>): string {
  return k.min != null && k.max != null ? `${formatKnobNumber(k.min)} – ${formatKnobNumber(k.max)}` : '—'
}

/** Clipboard write with a fallback for contexts where the async API is missing or refused. */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch { /* fall through to the legacy path */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('copy failed')
}

function DefaultCell({ knob }: { knob: KnobTableItem }) {
  if (knob.type === 'color') {
    const c = knobColor(knob.default)
    return (
      <span className={ds.knobRow.defaultCell}>
        <span className={ds.knobRow.swatch} data-part="swatch">
          <span className={ds.knobRow.swatchColor} data-part="swatch-color" style={{ backgroundColor: c.rgba }} />
        </span>
        <span className={ds.knobRow.defaultValue}>{c.hex}{' '}α {c.alpha.toFixed(2)}</span>
      </span>
    )
  }
  const text = Array.isArray(knob.default) ? knob.default.map(formatKnobNumber).join(', ') : formatKnobNumber(knob.default)
  return (
    <span className={ds.knobRow.defaultCell}>
      <span className={ds.knobRow.defaultValue}>{text}</span>
    </span>
  )
}

function KnobRow({ knob, copied, onClick }: { knob: KnobTableItem; copied: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(ds.knobRow.root, copied && ds.knobRow.rootLifted)}
      onClick={onClick}
      title={knob.key}
      aria-label={`Copy key ${knob.key}`}
      data-knob-key={knob.key}
      data-named={knob.named ? 'true' : 'false'}
    >
      <span className={ds.knobRow.keyCell}>
        <span className={cn(knob.named ? ds.knobRow.key : ds.knobRow.keyAuto, 'min-w-0')} data-part="key">{knob.key}</span>
        {copied ? (
          <>
            <icons.check className={ds.knobRow.checkIcon} data-part="check" />
            <span className={ds.knobRow.copied} data-part="copied">Copied</span>
          </>
        ) : (
          <icons.copy className={cn(ds.knobRow.copyIcon, 'hidden group-hover:block group-focus-visible:block')} data-part="copy-icon" />
        )}
        {knob.clash && (
          <>
            <icons.triangleAlert className={ds.knobRow.clashIcon} data-part="clash-icon" />
            <span className={ds.knobRow.clashHint} data-part="clash-hint">{knob.clashNote ?? DEFAULT_CLASH_NOTE}</span>
          </>
        )}
      </span>
      <span className={ds.knobRow.type}>{knob.type}</span>
      <DefaultCell knob={knob} />
      <span className={ds.knobRow.range}>{formatKnobRange(knob)}</span>
      {/* Reserved for the later annotation / expose controls. */}
      <span className={ds.knobRow.reserved} aria-hidden />
    </button>
  )
}

export function KnobTable({ knobs, onCopy, notice, footnote, copiedMs = COPIED_MS, className }: KnobTableProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = async (key: string) => {
    try {
      await (onCopy ? onCopy(key) : writeClipboard(key))
    } catch {
      return // nothing reached the clipboard: no "Copied"
    }
    if (timer.current) clearTimeout(timer.current)
    setCopiedKey(key)
    timer.current = setTimeout(() => setCopiedKey(null), copiedMs)
  }

  const named = knobs.filter((k) => k.named)
  const auto = knobs.filter((k) => !k.named)
  const row = (k: KnobTableItem) => (
    <KnobRow key={k.key} knob={k} copied={copiedKey === k.key} onClick={() => void copy(k.key)} />
  )

  return (
    <div className={cn(ds.knobTable.root, className)} data-part="knob-table">
      <div className={ds.knobTable.header}>
        <span className={ds.categoryHeader.root} data-part="title">Knobs · {knobs.length}</span>
        {knobs.length > 0 && <span className={ds.knobTable.copyHint}>Click a key to copy it</span>}
      </div>

      {notice && (
        <div className={ds.knobTable.noticeWrap}>
          <div className={ds.knobNotice.root} role="note" data-part="notice">
            <icons.triangleAlert className={ds.knobNotice.icon} />
            <p className={ds.knobNotice.text}>{notice}</p>
          </div>
        </div>
      )}

      {knobs.length === 0 ? (
        <div className={ds.knobTable.empty} data-part="empty">
          <p className={ds.knobTable.emptyText}>{EMPTY_TEXT}</p>
        </div>
      ) : (
        <>
          <div className={ds.knobTable.table}>
            <div className={ds.tableHeader.root} data-part="header">
              <span className={ds.tableHeader.colKey}>Key</span>
              <span className={ds.tableHeader.colType}>Type</span>
              <span className={ds.tableHeader.colDefault}>Default</span>
              <span className={ds.tableHeader.colRange}>Range</span>
              <span className={ds.tableHeader.colReserved} aria-hidden />
            </div>
            <div className={ds.knobTable.body} data-part="body">
              {named.map(row)}
              {named.length > 0 && auto.length > 0 && (
                <div className={ds.knobTable.divider} data-part="divider"><Separator /></div>
              )}
              {auto.map(row)}
            </div>
          </div>
          {footnote && (
            <div className={ds.knobTable.hintRow}>
              <p className={ds.knobTable.hint}>{footnote}</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
