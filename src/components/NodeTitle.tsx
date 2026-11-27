/**
 * NodeTitle — the title region of a node header, with inline rename.
 *
 * Drop-in for `<BaseNodeHeaderTitle>{label}</BaseNodeHeaderTitle>` inside a
 * `<BaseNodeHeader>`: it fills the same flex-1 slot and leaves the header itself
 * (32px, padding, border) untouched. Figma: board "Node — inline rename"
 * (993:3781), component set "Inline Text Field" (993:3749).
 *
 * - No custom name: shows the type label, exactly as before.
 * - Custom name: shows the name; a "?" at the header's far right reveals the
 *   node's type label on hover (it replaces the old inline type tag). A long
 *   name truncates with an ellipsis (full name in the tooltip).
 * - The pencil button follows the title text (hover/focus reveals it; its
 *   24 px slot is always laid out so nothing shifts).
 * - Pencil click OR double-click on the title → an inline field in the same
 *   place and size, whole text selected. Enter / click-away saves, Escape
 *   cancels, an empty field clears the custom name (onRename(undefined)).
 * - `duplicate`: a small amber warning before the name, explained by its
 *   tooltip. No tint, no red. (The caller drops the header's left padding to
 *   xs so the 24 px warning slot sits flush.)
 *
 * Renders the title group AND the "?" slot, so it must be a direct child of
 * the header (a flex row with justify-between).
 *
 * Pure: no store access. Editing state is internal; the caller owns the name.
 * There is no visible length limit — `maxLength` on the input is only a silent
 * safety net (the store caps names too).
 */

import { useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { icons } from '@/components/icons'
import { Tooltip } from '@/components/Tooltip'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'

/** Silent safety cap; never shown to the user. */
export const NODE_NAME_MAX_LENGTH = 120

export const DUPLICATE_NAME_MESSAGE = 'Another node has this name — exported controls will be numbered'

export interface NodeTitleProps {
  /** The node's type label ("Number", "Gradient"…). */
  title: string
  /** The author's name for this node, if any. */
  customName?: string
  /** Another node carries the same custom name. */
  duplicate?: boolean
  /**
   * Called once per saved edit that changes the name. `undefined` clears the
   * custom name (empty field, or the field set back to the type label).
   * Not called when the edit is cancelled or leaves the name unchanged.
   */
  onRename: (name: string | undefined) => void
  className?: string
}

export function NodeTitle({ title, customName, duplicate = false, onRename, className }: NodeTitleProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Set once an edit is saved or cancelled, so the blur that follows the
  // input's unmount (or an Enter followed by blur) can't save a second time.
  const settled = useRef(false)

  const name = customName || undefined
  const shown = name ?? title

  const startEdit = () => {
    settled.current = false
    setDraft(shown)
    setEditing(true)
  }

  // Focus + select the whole text before paint, so the first keystroke replaces it.
  useLayoutEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const finish = (save: boolean) => {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    if (!save) return
    const trimmed = draft.trim()
    const next = trimmed === '' || trimmed === title ? undefined : trimmed
    if (next !== name) onRename(next)
  }

  const Help = icons.questionMark
  // Always laid out (24 px) so a rename never shifts the header; only shown for a
  // renamed node, where it reveals the node's type on hover/focus.
  const helpSlot = name ? (
    <Tooltip content={{ message: title, hint: 'Node type' }} align="end">
      <span
        data-slot="node-title-help"
        role="img"
        aria-label={`Node type: ${title}`}
        tabIndex={0}
        className={ds.nodeTitle.help}
      >
        <Help className="size-icon-sm" />
      </span>
    </Tooltip>
  ) : (
    <span data-slot="node-title-help" aria-hidden className={cn(ds.nodeTitle.help, 'invisible pointer-events-none')}>
      <Help className="size-icon-sm" />
    </span>
  )

  if (editing) {
    return (
      <>
      <div data-slot="node-title" className={cn(ds.nodeTitle.root, 'w-0', className)}>
        <input
          ref={inputRef}
          data-slot="node-title-input"
          aria-label="Node name"
          // Bleeds 6px into the header padding, as in Figma, so the text lands
          // where the title text was — nothing jumps.
          className={cn(ds.inlineTextField.field, ds.inlineTextField.value, 'flex-1 -mx-sm nodrag nopan nokey')}
          value={draft}
          placeholder={title}
          maxLength={NODE_NAME_MAX_LENGTH}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            // Never let editing keys reach the canvas: Backspace/Delete would
            // delete the node, Escape/F would toggle app modes.
            e.stopPropagation()
            // IME: Enter/Escape while composing belong to the composition.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter') { e.preventDefault(); finish(true) }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
          }}
          onKeyUp={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      </div>
      {helpSlot}
      </>
    )
  }

  const Warning = icons.triangleAlert
  return (
    <>
    {/* `w-0` + flex-1: the title never widens the node — a long name truncates
        inside whatever width the node already has. Order: [warning] name pencil. */}
    <div data-slot="node-title" className={cn(ds.nodeTitle.root, 'group/title w-0', className)}>
      {duplicate && (
        <Tooltip content={{ message: 'Duplicate name', hint: DUPLICATE_NAME_MESSAGE, tone: 'warning' }} align="start">
          <span
            data-slot="node-title-warning"
            role="img"
            aria-label={DUPLICATE_NAME_MESSAGE}
            tabIndex={0}
            className={ds.nodeTitle.warning}
          >
            <Warning className="size-icon-sm" />
          </span>
        </Tooltip>
      )}
      <h3
        data-slot="node-title-name"
        className={ds.nodeTitle.name}
        title={shown}
        onDoubleClick={(e) => {
          e.stopPropagation()
          startEdit()
        }}
      >
        {shown}
      </h3>
      {/* Always laid out, only shown on hover/focus — mounting it on hover would shift the header. */}
      <Tooltip content={{ message: 'Rename' }}>
        <IconButton
          icon="pencil"
          data-slot="node-title-pencil"
          aria-label="Rename node"
          className={cn(
            ds.nodeTitle.pencil,
            'nodrag nopan transition opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100',
          )}
          onClick={(e) => {
            e.stopPropagation()
            startEdit()
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      </Tooltip>
    </div>
    {helpSlot}
    </>
  )
}
