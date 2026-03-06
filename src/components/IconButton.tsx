/**
 * IconButton — unified button component (icon or text content).
 * Wraps shadcn Button (unstyled) with ds.button.* classes from the DS.
 *
 * Always applies ds.button.root for layout/sizing.
 * Pass a state class via className: ds.button.ghost, .solid, .ghostActive, etc.
 * Defaults to ghost styling when no className is provided.
 *
 * For text content, pass `label` instead of `icon`.
 */

import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import { icons, type IconName } from '@/components/icons'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

type IconButtonProps = React.ComponentProps<typeof Button> & (
  | { icon: IconName; label?: never; iconClassName?: string }
  | { icon?: never; label: string; iconClassName?: never }
)

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, label, iconClassName, className, variant = 'unstyled', size = 'icon-node', ...props }, ref) => {
    const Icon = icon ? icons[icon] : null
    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        className={cn(ds.button.root, className || (label ? ds.button.textGhost : ds.button.ghost))}
        {...props}
      >
        {Icon ? <Icon className={iconClassName} /> : label}
      </Button>
    )
  },
)
IconButton.displayName = 'IconButton'
