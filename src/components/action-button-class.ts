import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'

export type ActionButtonVariant = 'secondary' | 'primary'

export function actionButtonClass(
  variant: ActionButtonVariant = 'secondary',
  disabled = false,
  className?: string,
) {
  const variantClass =
    variant === 'primary'
      ? disabled
        ? ds.actionButton.primaryDisabled
        : ds.actionButton.primary
      : ds.actionButton.secondary

  return cn(variantClass, className)
}
