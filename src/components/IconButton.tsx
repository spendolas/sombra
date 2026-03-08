/**
 * IconButton — unified button component (icon or text content).
 * Uses ds.button.* classes from the DS for all visual styling.
 *
 * Always applies ds.button.root for layout/sizing.
 * Pass a state class via className: ds.button.ghost, .solid, .ghostActive, etc.
 * Defaults to ghost styling when no className is provided.
 *
 * For text content, pass `label` instead of `icon`.
 */

import { forwardRef } from 'react'
import { icons, type IconName } from '@/components/icons'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

type IconButtonProps = React.ComponentProps<"button"> & (
  | { icon: IconName; label?: never; iconClassName?: string }
  | { icon?: never; label: string; iconClassName?: never }
)

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, iconClassName, className, ...props }, ref) => {
    const Icon = icon ? icons[icon] : null
    const stateClass = className || (label ? ds.button.textGhost : ds.button.ghost)
    return (
      <button
        ref={ref}
        className={cn(ds.button.root, label && ds.textGhostButton.root, stateClass)}
        {...props}
      >
        {Icon ? (
          <Icon className={cn("size-icon-sm", iconClassName)} />
        ) : (
          <span className="tabular-nums">{label}</span>
        )}
      </button>
    )
  },
)
IconButton.displayName = 'IconButton'
