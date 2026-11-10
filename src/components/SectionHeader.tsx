/**
 * SectionHeader — the collapsible header of a node-body section (today: the
 * framework Transform section of every spatial node).
 *
 * Designed in Figma first: component set "Section Header" (993:3777, State =
 * open / collapsed / hover) and the board "Transform — collapsed wires"
 * (994:4107), Option A + drop behaviour 1. Styled entirely from `ds.sectionHeader`.
 *
 * What the design settled, enforced here:
 *  - Collapsed with N wired params: one gathered dot sits on the header's handle
 *    column and the label reads "Transform · N". Open: dot and count go away —
 *    the wires return to their own rows.
 *  - Pointer on the dot (or keyboard focus on the header) shows a popover naming
 *    the param each wire feeds and its source ("→ Scale   from Noise.value"),
 *    and the header takes its hover look. Clicking the dot opens the section.
 *  - A wire dragged over a COLLAPSED header lights it up as a drop target; after
 *    `openDelay` ms (default 400) the section opens under the pointer. Leaving
 *    earlier cancels. An open header is never a drop target — its rows are.
 *
 * Pure: no store access and no React Flow. The gathered dot is a slot
 * (`renderGatherHandle`): the node passes its real handles, the sandbox a dot.
 */

import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'
import { icons } from '@/components/icons'

export interface SectionWire {
  /** The param the wire feeds, as its row labels it ("Scale"). */
  label: string
  /** What drives it, "<Node label>.<output>" ("Noise.value"). */
  source: string
}

export interface SectionHeaderProps {
  /** Section title ("Transform"). Rendered upper-case by the text style. */
  label: string
  open: boolean
  /** Called with the requested next state (click, dot click, or drag-over dwell). */
  onToggle: (next: boolean) => void
  /** Wired params inside the section. Their count is the "· N" badge and the dot. */
  wiredParams?: SectionWire[]
  /**
   * A wire is being dragged somewhere on the canvas. While true, the pointer
   * entering the header counts as dragging over it (mouse/pen without capture).
   */
  connecting?: boolean
  /**
   * Controlled drag-over. When set it overrides pointer detection — for a parent
   * that hit-tests the drag itself (touch drags capture the pointer, so the header
   * never sees pointerenter), and for fixtures.
   */
  dropActive?: boolean
  /** Dwell before a drag-over opens the section, ms. */
  openDelay?: number
  /**
   * Controlled popover. Undefined = the header decides (dot hover / keyboard
   * focus). The node sets it while the pointer is on one of the gathered wires.
   */
  popoverOpen?: boolean
  /** The pointer entered / left the gathered dot — lets the node thicken the wires. */
  onGatherHoverChange?: (hovered: boolean) => void
  /** The gathered handle(s). Rendered only while collapsed with at least one wire. */
  renderGatherHandle?: (ctx: { count: number }) => ReactNode
  /** id of the section body, for aria-controls. */
  controlsId?: string
  className?: string
}

export function SectionHeader({
  label,
  open,
  onToggle,
  wiredParams = [],
  connecting = false,
  dropActive,
  openDelay = 400,
  popoverOpen,
  onGatherHoverChange,
  renderGatherHandle,
  controlsId,
  className,
}: SectionHeaderProps) {
  const count = wiredParams.length
  const gathered = !open && count > 0

  // ── Drag-over (open on drag) ───────────────────────────────────────────────
  const [pointerOver, setPointerOver] = useState(false)
  const dragOver = !open && (dropActive ?? (connecting && pointerOver))

  // The latest onToggle, so a parent re-rendering with a fresh callback does not
  // restart the dwell timer.
  const onToggleRef = useRef(onToggle)
  useEffect(() => { onToggleRef.current = onToggle })

  useEffect(() => {
    if (!dragOver) return
    const t = window.setTimeout(() => onToggleRef.current(true), openDelay)
    return () => window.clearTimeout(t)
  }, [dragOver, openDelay])

  // A drag that ended while over the header leaves no pointerleave behind.
  useEffect(() => { if (!connecting) setPointerOver(false) }, [connecting])

  // ── Popover ────────────────────────────────────────────────────────────────
  const [dotHover, setDotHover] = useState(false)
  const [keyboardFocus, setKeyboardFocus] = useState(false)
  const showPopover = gathered && (popoverOpen ?? (dotHover || keyboardFocus))
  const popoverId = useId()

  const setDot = (hovered: boolean) => {
    setDotHover(hovered)
    onGatherHoverChange?.(hovered)
  }
  // Leaving the gathered state (opened, or last wire removed) ends the hover.
  useEffect(() => {
    if (!gathered && dotHover) { setDotHover(false); onGatherHoverChange?.(false) }
  }, [gathered, dotHover, onGatherHoverChange])

  const onFocus = (e: FocusEvent<HTMLButtonElement>) => {
    // Keyboard focus only: a mouse click focuses the button too, and the popover
    // must not pop up under a click that is already opening the section.
    let visible = true
    try { visible = e.currentTarget.matches(':focus-visible') } catch { /* old engines */ }
    setKeyboardFocus(visible)
  }

  const hoverLook = showPopover

  return (
    <div
      className={cn(dragOver ? ds.sectionHeader.rootDropTarget : ds.sectionHeader.root, className)}
      data-state={open ? 'open' : 'collapsed'}
      data-drop-active={dragOver ? 'true' : undefined}
      onPointerEnter={() => setPointerOver(true)}
      onPointerLeave={() => setPointerOver(false)}
    >
      {gathered && renderGatherHandle && (
        <span
          className={ds.sectionHeader.gather}
          data-gather=""
          onPointerEnter={() => setDot(true)}
          onPointerLeave={() => setDot(false)}
          onClick={() => onToggle(true)}
        >
          {renderGatherHandle({ count })}
        </span>
      )}

      <button
        type="button"
        className={ds.sectionHeader.toggle}
        aria-expanded={open}
        aria-controls={controlsId}
        aria-describedby={showPopover ? popoverId : undefined}
        onClick={() => onToggle(!open)}
        onFocus={onFocus}
        onBlur={() => setKeyboardFocus(false)}
      >
        <icons.chevronDown
          aria-hidden
          className={cn(
            hoverLook ? ds.sectionHeader.chevronHover : ds.sectionHeader.chevron,
            !open && ds.sectionHeader.chevronCollapsed,
          )}
        />
        <span className={hoverLook ? ds.sectionHeader.labelHover : ds.sectionHeader.label}>{label}</span>
        {gathered && <span className={ds.sectionHeader.count} data-count={count}>· {count}</span>}
      </button>

      {showPopover && (
        <div id={popoverId} role="tooltip" className={ds.sectionHeader.popover}>
          {wiredParams.map((w, i) => (
            <div key={`${i}:${w.label}`} className={ds.sectionHeader.popoverRow}>
              <span className={ds.sectionHeader.popoverParam}>→ {w.label}</span>
              <span className={ds.sectionHeader.popoverSource}>from {w.source}</span>
            </div>
          ))}
          <span className={ds.sectionHeader.popoverHint}>Click to open {label}</span>
        </div>
      )}
    </div>
  )
}
