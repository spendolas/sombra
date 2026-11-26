/**
 * KnobTable — the published knobs of a scene, as a host will address them.
 *
 * Designed in Figma on the board "Embed modal — knob table" (993:3778), with
 * renaming and hiding on "Embed modal — knob rename + hide" (1023:7776); the rows
 * are the Knob Row set (994:4106) under the Table Header (994:4033). It lives in
 * the Embed modal's "Control it from JavaScript" section, under the snippet.
 *
 * Presentational and pure: the caller hands it knobs and the two edit callbacks;
 * it reads no store.
 *
 *   - Named knobs first (in the order given), a thin divider, then the
 *     auto-named rest with slightly dimmer keys.
 *   - The body stops at about eleven rows and scrolls under a header that is
 *     outside the scroll box, so it cannot scroll away.
 *   - Each row starts with a Name field (borderless; its border shows on row
 *     hover, indigo while editing). Typing updates the key beside it live; Enter
 *     or blur saves, Esc cancels, an empty name goes back to the param's label.
 *   - Clicking a KEY copies it (nothing else): copy icon after the key on
 *     hover; afterwards a green check and "Copied" for 1.5 s, the same icons and
 *     timing as the Embed modal's snippet copy buttons.
 *   - An eye at the end of each row hides the knob from the embed: the row dims
 *     to half opacity (as hidden Stack layers do) and keeps its place, and a
 *     footer counts published and hidden knobs.
 *   - A name clash shows as a calm notice above the table plus a small amber
 *     mark on the numbered row.
 */

import { useEffect, useRef, useState } from 'react'
import type { KnobDescriptor } from '@/embed/artifact'
import { icons } from '@/components/icons'
import { IconButton } from '@/components/IconButton'
import { Separator } from '@/components/ui/separator'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'

/**
 * One row. The first six fields are KnobDescriptor's own (`named`: listed
 * first, full-strength key); the clash fields come from the manifest's de-dupe
 * pass (`KnobNameClash`), which the caller maps onto the rows.
 */
export type KnobTableItem = Pick<KnobDescriptor, 'key' | 'type' | 'default' | 'min' | 'max' | 'named'> & {
  /** Stable row identity for the edit callbacks. Default: the key. */
  id?: string
  /** The knob's name as shown in the Name field. Default: none (the field is left out). */
  name?: string
  /** What an emptied name goes back to (the param's own label); the field's placeholder. */
  defaultName?: string
  /**
   * The key with the name part removed, e.g. "site-balance-": the live key while
   * typing is this plus the slug of the draft. Default: no live preview.
   */
  keyPrefix?: string
  /** Hidden from the embed: the row dims and the eye shows eye-off. */
  hidden?: boolean
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
  /** Save a knob's name ('' = back to its label). Without it the Name field is read-only. */
  onRename?: (id: string, name: string) => void
  /** Show or hide a knob. Without it the eye is not drawn. */
  onToggleHidden?: (id: string, hidden: boolean) => void
  className?: string
}

export const COPIED_MS = 1500
const DEFAULT_CLASH_NOTE = 'name clash, numbered'
export const HIDDEN_NOTE = 'Hidden knobs keep the value set here and are left out of the published key list.'
export const EMPTY_TEXT = 'This scene has no knobs: hosts can show it, but there is nothing to drive.'

const MINUS = '−'

/** The key slug rule (src/embed/manifest.ts `slugify`) for the live preview. */
const keySlug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const rowId = (k: KnobTableItem) => k.id ?? k.key

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

function DefaultCell({ knob, className }: { knob: KnobTableItem; className?: string }) {
  if (knob.type === 'color') {
    const c = knobColor(knob.default)
    return (
      <span className={cn(ds.knobRow.defaultCell, className)} data-part="default">
        <span className={ds.knobRow.swatch} data-part="swatch">
          <span className={ds.knobRow.swatchColor} data-part="swatch-color" style={{ backgroundColor: c.rgba }} />
        </span>
        <span className={ds.knobRow.defaultValue}>{c.hex}{' '}α {c.alpha.toFixed(2)}</span>
      </span>
    )
  }
  const text = Array.isArray(knob.default) ? knob.default.map(formatKnobNumber).join(', ') : formatKnobNumber(knob.default)
  return (
    <span className={cn(ds.knobRow.defaultCell, className)} data-part="default">
      <span className={ds.knobRow.defaultValue}>{text}</span>
    </span>
  )
}

/**
 * The Name field: a borderless input that edits in place. It keeps a draft while
 * focused and reports it upward (for the live key); Enter / blur commit, Esc
 * reverts. A commit equal to the current name is not reported.
 */
function NameField({ knob, className, onCommit, onDraft }: {
  knob: KnobTableItem
  className?: string
  onCommit?: (name: string) => void
  onDraft: (draft: string | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const value = draft ?? knob.name ?? ''
  const finish = (commit: boolean) => {
    if (draft !== null && commit && onCommit) {
      // '' = "no custom name" (the label). Typing the label itself back means the same.
      const def = knob.defaultName ?? ''
      const asOverride = (n: string) => (n === '' || n === def ? '' : n)
      const next = asOverride(draft.trim())
      if (next !== asOverride(knob.name ?? '')) onCommit(next)
    }
    setDraft(null)
    onDraft(null)
  }
  return (
    <input
      className={cn(ds.knobRow.nameField, ds.knobRow.name, className)}
      value={value}
      placeholder={knob.defaultName}
      readOnly={!onCommit}
      spellCheck={false}
      aria-label={`Name of ${knob.key}`}
      data-part="name"
      onFocus={(e) => { cancelled.current = false; e.currentTarget.select() }}
      onChange={(e) => { setDraft(e.target.value); onDraft(e.target.value) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur() }
        else if (e.key === 'Escape') { e.stopPropagation(); cancelled.current = true; setDraft(null); onDraft(null); e.currentTarget.blur() }
      }}
      onBlur={() => finish(!cancelled.current)}
    />
  )
}

function KnobRow({ knob, copied, onCopy, onRename, onToggleHidden }: {
  knob: KnobTableItem
  copied: boolean
  onCopy: () => void
  onRename?: (name: string) => void
  onToggleHidden?: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // While typing, the key shows what the draft would publish as.
  const liveKey = draft !== null && knob.keyPrefix !== undefined
    ? knob.keyPrefix + (keySlug(draft) || keySlug(knob.defaultName ?? '') || 'value')
    : knob.key
  const editing = draft !== null
  const dim = knob.hidden ? ds.knobRow.dimmed : undefined
  return (
    <div
      className={cn(ds.knobRow.root, copied && ds.knobRow.rootLifted)}
      data-knob-key={knob.key}
      data-named={knob.named ? 'true' : 'false'}
      data-hidden={knob.hidden ? 'true' : 'false'}
    >
      {knob.name !== undefined && (
        <NameField knob={knob} className={dim} onCommit={onRename} onDraft={setDraft} />
      )}
      <button
        type="button"
        className={cn(ds.knobRow.keyCell, dim)}
        onClick={onCopy}
        title={liveKey}
        aria-label={`Copy key ${liveKey}`}
        data-part="key-cell"
      >
        <span className={cn(knob.named ? ds.knobRow.key : ds.knobRow.keyAuto, editing && 'text-fg', 'min-w-0')} data-part="key">{liveKey}</span>
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
      </button>
      <span className={cn(ds.knobRow.type, dim)} data-part="type">{knob.type}</span>
      <DefaultCell knob={knob} className={dim} />
      <span className={cn(ds.knobRow.range, dim)} data-part="range">{formatKnobRange(knob)}</span>
      {onToggleHidden && (
        <IconButton
          icon={knob.hidden ? 'eyeOff' : 'eye'}
          onClick={onToggleHidden}
          aria-label={knob.hidden ? `Show ${knob.key} in the embed` : `Hide ${knob.key} from the embed`}
          aria-pressed={knob.hidden ? 'true' : 'false'}
          title={knob.hidden ? 'Hidden from the embed' : 'Published'}
          data-part="visibility"
        />
      )}
    </div>
  )
}

export function KnobTable({ knobs, onCopy, notice, footnote, copiedMs = COPIED_MS, onRename, onToggleHidden, className }: KnobTableProps) {
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
  const withNames = knobs.some((k) => k.name !== undefined)
  const hiddenCount = knobs.filter((k) => k.hidden).length
  const row = (k: KnobTableItem) => (
    <KnobRow
      key={rowId(k)}
      knob={k}
      copied={copiedKey === k.key}
      onCopy={() => void copy(k.key)}
      onRename={onRename ? (name) => onRename(rowId(k), name) : undefined}
      onToggleHidden={onToggleHidden ? () => onToggleHidden(rowId(k), !k.hidden) : undefined}
    />
  )

  return (
    <div className={cn(ds.knobTable.root, className)} data-part="knob-table">
      <div className={ds.knobTable.header}>
        <span className={ds.categoryHeader.root} data-part="title">Knobs · {knobs.length}</span>
        {knobs.length > 0 && (
          <span className={ds.knobTable.copyHint}>
            {withNames && onRename ? 'Click a name to edit it · click a key to copy it' : 'Click a key to copy it'}
          </span>
        )}
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
              {withNames && (
                <span className={ds.tableHeader.colName}><span className={ds.tableHeader.colNameLabel}>Name</span></span>
              )}
              <span className={ds.tableHeader.colKey}>Key</span>
              <span className={ds.tableHeader.colType}>Type</span>
              <span className={ds.tableHeader.colDefault}>Default</span>
              <span className={ds.tableHeader.colRange}>Range</span>
              {onToggleHidden && <span className={ds.tableHeader.colVisibility} aria-hidden />}
            </div>
            <div className={ds.knobTable.body} data-part="body">
              {named.map(row)}
              {named.length > 0 && auto.length > 0 && (
                <div className={ds.knobTable.divider} data-part="divider"><Separator /></div>
              )}
              {auto.map(row)}
            </div>
            {hiddenCount > 0 && (
              <div className={ds.knobTable.footer} data-part="footer">
                <span className={ds.knobTable.footerCount} data-part="count">
                  {knobs.length - hiddenCount} published · {hiddenCount} hidden
                </span>
                <span className={ds.knobTable.footerNote}>{HIDDEN_NOTE}</span>
              </div>
            )}
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
