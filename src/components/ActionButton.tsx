import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { actionButtonClass, type ActionButtonVariant } from '@/components/action-button-class'

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionButtonVariant
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(
  ({ className, disabled = false, type = 'button', variant = 'secondary', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={actionButtonClass(variant, disabled, className)}
      {...props}
    />
  ),
)

ActionButton.displayName = 'ActionButton'
