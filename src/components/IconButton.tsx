/**
 * IconButton — unified icon button component.
 * Wraps shadcn Button with a swappable icon from the icons registry.
 *
 * Toolbar context:  <IconButton icon="download" />                    (defaults: ghost + icon)
 * Node context:     <IconButton icon="plus" variant="unstyled" size="icon-node" className={ds...} />
 */

import { forwardRef } from 'react'
import { Button } from '@/components/ui/button'
import { icons, type IconName } from '@/components/icons'

interface IconButtonProps extends React.ComponentProps<typeof Button> {
  icon: IconName
  iconClassName?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, iconClassName, variant = 'ghost', size = 'icon', ...props }, ref) => {
    const Icon = icons[icon]
    return (
      <Button ref={ref} variant={variant} size={size} {...props}>
        <Icon className={iconClassName} />
      </Button>
    )
  },
)
IconButton.displayName = 'IconButton'
