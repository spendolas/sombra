import { Select as SelectPrimitive } from "radix-ui"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ds } from "@/generated/ds"

function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root {...props} />
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
          <ChevronDownIcon className="size-3.5 opacity-50" />
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
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
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
