import { createContext, useContext } from "react"
import { Select as SelectPrimitive } from "radix-ui"
import { icons } from "@/components/icons"
import { cn } from "@/lib/utils"
import { ds } from "@/generated/ds"

const ChevronDown = icons.chevronDown

/**
 * Reports the option being TRIED while the menu is open — highlighted by
 * pointer or arrow keys — and `null` when nothing is (pointer left the list,
 * or the menu closed, picked or not). Choosing still goes through
 * `onValueChange`; a preview never changes the value.
 */
const PreviewContext = createContext<((value: string | null) => void) | undefined>(undefined)

function Select({
  onPreview,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root> & {
  onPreview?: (value: string | null) => void
}) {
  return (
    <PreviewContext.Provider value={onPreview}>
      <SelectPrimitive.Root
        onOpenChange={(open) => {
          if (!open) onPreview?.(null)
          onOpenChange?.(open)
        }}
        {...props}
      />
    </PreviewContext.Provider>
  )
}

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value {...props} />
}

function SelectTrigger({
  className,
  size: _size,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      className={cn(ds.enumSelect.trigger, "outline-none focus:border-active", className)}
      {...props}
    >
      <span className="flex w-full items-center justify-between gap-md">
        {children}
        <SelectPrimitive.Icon>
          <ChevronDown className="size-icon-sm opacity-50" />
        </SelectPrimitive.Icon>
      </span>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        className={cn(
          ds.enumSelect.content,
          "z-50 max-h-(--radix-select-content-available-height) overflow-y-auto rounded-md shadow-md",
          className
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-xs">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({
  className,
  children,
  onFocus,
  onBlur,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  const onPreview = useContext(PreviewContext)
  return (
    <SelectPrimitive.Item
      // Radix highlights an item by focusing it, for pointer and keys alike.
      onFocus={(e) => { onPreview?.(props.value); onFocus?.(e) }}
      onBlur={(e) => { onPreview?.(null); onBlur?.(e) }}
      className={cn(
        ds.enumSelect.item,
        "text-fg outline-none rounded-sm px-sm py-xs",
        "hover:bg-highlight data-[highlighted]:bg-highlight",
        "data-[state=checked]:text-active",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
}
