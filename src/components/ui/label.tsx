import { cn } from "@/lib/utils"

function Label({
  className,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "flex items-center select-none",
        className
      )}
      {...props}
    />
  )
}

export { Label }
