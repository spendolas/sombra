/**
 * IconButton — unified icon button component.
 * Wraps shadcn Button (unstyled) with ds.iconButton.* classes from the DS.
 *
 * Always applies ds.iconButton.root for layout/sizing.
 * Pass a state class via className: ds.iconButton.ghost, .solid, .ghostActive, etc.
 * Defaults to ghost styling when no className is provided.
 */

import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import { icons, type IconName } from '@/components/icons'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

interface IconButtonProps extends React.ComponentProps<typeof Button> {
  icon: IconName
  iconClassName?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, iconClassName, className, variant = 'unstyled', size = 'icon-node', ...props }, ref) => {
    const Icon = icons[icon]
    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        className={cn(ds.iconButton.root, className || ds.iconButton.ghost)}
        {...props}
      >
        <Icon className={iconClassName} />
      </Button>
    )
  },
)
IconButton.displayName = 'IconButton'
