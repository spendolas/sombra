/**
 * Tooltip — small, reusable hover/focus tooltip with a one-piece caret.
 * Figma: "DRAFT — Tooltip v2 (one-piece caret)" (1028:11193).
 *
 *   <Tooltip content={{ message: 'Rename' }}><button …/></Tooltip>
 *   <Tooltip content={{ message: 'Reeded Glass', hint: 'Node type' }} align="end">…</Tooltip>
 *
 * - Clones its single child (must accept a ref + DOM event props) — no wrapper element.
 * - Shows after 400 ms of hover, immediately on keyboard focus.
 * - Hides on leave, blur, Escape, pointerdown, wheel and scroll.
 * - Rendered in a portal (fixed), so node overflow / canvas transforms never clip it.
 * - Placement flips if there is no room; the caret keeps pointing at the trigger centre.
 * - `tone: 'warning'` adds a warning icon before the message.
 */

import {
  cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ReactElement, type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { icons } from '@/components/icons'
import { ds } from '@/generated/ds'
import { CARET_DEPTH, tooltipOutline, type CaretSide } from '@/components/tooltip-shape'

export interface TooltipContent {
  message: string
  /** Optional dimmer second line. */
  hint?: string
  tone?: 'default' | 'warning'
}

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'
export type TooltipAlign = 'start' | 'center' | 'end'

export interface TooltipProps {
  content: TooltipContent
  /** Which side of the trigger the bubble sits on. Default 'bottom'. */
  placement?: TooltipPlacement
  /** Alignment along that side. 'end' = bubble's right/bottom edge lines up with the trigger's. */
  align?: TooltipAlign
  delay?: number
  children: ReactElement<Record<string, unknown>>
}

const GAP = 4 // trigger → caret tip
const MARGIN = 8 // viewport edge

const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = {
  top: 'bottom', bottom: 'top', left: 'right', right: 'left',
}
// Caret sits on the bubble edge facing the trigger.
const CARET_SIDE: Record<TooltipPlacement, CaretSide> = {
  bottom: 'top', top: 'bottom', right: 'left', left: 'right',
}

interface Layout {
  left: number
  top: number
  width: number
  height: number
  d: string
  contentLeft: number
  contentTop: number
}

function computeLayout(trigger: DOMRect, bubble: { w: number; h: number }, placement: TooltipPlacement, align: TooltipAlign): Layout {
  const vw = window.innerWidth, vh = window.innerHeight
  const fits = (p: TooltipPlacement) => {
    const need = (p === 'top' || p === 'bottom' ? bubble.h : bubble.w) + CARET_DEPTH + GAP + MARGIN
    switch (p) {
      case 'bottom': return vh - trigger.bottom >= need
      case 'top': return trigger.top >= need
      case 'right': return vw - trigger.right >= need
      case 'left': return trigger.left >= need
    }
  }
  const side = fits(placement) || !fits(OPPOSITE[placement]) ? placement : OPPOSITE[placement]
  const horizontal = side === 'top' || side === 'bottom'

  // Position of the bubble along the free axis, then the caret offset within it.
  const tStart = horizontal ? trigger.left : trigger.top
  const tSize = horizontal ? trigger.width : trigger.height
  const bSize = horizontal ? bubble.w : bubble.h
  const limit = (horizontal ? vw : vh) - MARGIN
  let start = align === 'start' ? tStart : align === 'end' ? tStart + tSize - bSize : tStart + tSize / 2 - bSize / 2
  start = Math.max(MARGIN, Math.min(limit - bSize, start))
  const at = tStart + tSize / 2 - start

  const o = tooltipOutline(bubble.w, bubble.h, CARET_SIDE[side], at)
  let left: number, top: number
  switch (side) {
    case 'bottom': left = start; top = trigger.bottom + GAP; break
    case 'top': left = start; top = trigger.top - GAP - o.height; break
    case 'right': left = trigger.right + GAP; top = start; break
    case 'left': left = trigger.left - GAP - o.width; top = start; break
  }
  return { left, top, width: o.width, height: o.height, d: o.d, contentLeft: o.bubbleX, contentTop: o.bubbleY }
}

export function Tooltip({ content, placement = 'bottom', align = 'center', delay = 400, children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<Layout | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const id = useId()
  const Warning = icons.triangleAlert

  const clear = () => { window.clearTimeout(timer.current); timer.current = undefined }
  const hide = useCallback(() => { clear(); setOpen(false); setLayout(null) }, [])
  const showSoon = () => { clear(); timer.current = window.setTimeout(() => setOpen(true), delay) }
  const showNow = () => { clear(); setOpen(true) }

  useEffect(() => clear, [])

  // Measure the bubble, then place it — before paint, so it never flashes at 0,0.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !contentRef.current) return
    const r = contentRef.current.getBoundingClientRect()
    setLayout(computeLayout(triggerRef.current.getBoundingClientRect(), { w: r.width, h: r.height }, placement, align))
  }, [open, placement, align, content.message, content.hint, content.tone])

  // Dismissers while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('wheel', hide, { capture: true, passive: true })
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('wheel', hide, true)
      window.removeEventListener('scroll', hide, true)
    }
  }, [open, hide])

  const childProps = children.props as Record<string, ((e: unknown) => void) | undefined> & { ref?: Ref<HTMLElement> }
  const chain = (name: string, fn: () => void) => (e: unknown) => { childProps[name]?.(e); fn() }
  const childRef = (children as unknown as { ref?: Ref<HTMLElement> }).ref ?? childProps.ref

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      if (typeof childRef === 'function') childRef(node)
      else if (childRef && typeof childRef === 'object') (childRef as { current: HTMLElement | null }).current = node
    },
    'aria-describedby': open ? id : childProps['aria-describedby'],
    onPointerEnter: chain('onPointerEnter', showSoon),
    onPointerLeave: chain('onPointerLeave', hide),
    onFocus: (e: unknown) => {
      childProps.onFocus?.(e)
      // Keyboard focus only — a click that focuses the trigger must not reopen it.
      const t = (e as { target?: Element }).target
      if (t?.matches?.(':focus-visible')) showNow()
    },
    onBlur: chain('onBlur', hide),
  })

  const warn = content.tone === 'warning'
  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            data-slot="tooltip"
            className={ds.tooltip.root}
            style={{
              left: layout?.left ?? 0,
              top: layout?.top ?? 0,
              width: layout?.width,
              height: layout?.height,
              visibility: layout ? 'visible' : 'hidden',
            }}
          >
            {layout && (
              <svg className={ds.tooltip.shape} width={layout.width} height={layout.height} aria-hidden>
                <path d={layout.d} />
              </svg>
            )}
            <div
              ref={contentRef}
              className={ds.tooltip.content}
              style={layout ? { left: layout.contentLeft, top: layout.contentTop, position: 'absolute' } : undefined}
            >
              {warn ? (
                <div className={ds.tooltip.warningRow}>
                  <Warning className={`${ds.tooltip.warningIcon} size-icon-sm`} />
                  <span className={ds.tooltip.message}>{content.message}</span>
                </div>
              ) : (
                <span className={ds.tooltip.message}>{content.message}</span>
              )}
              {content.hint && <span className={ds.tooltip.hint}>{content.hint}</span>}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
