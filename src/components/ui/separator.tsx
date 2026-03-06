import { cn } from "@/lib/utils"
import { ds } from "@/generated/ds"

interface SeparatorProps extends React.ComponentProps<"div"> {
  orientation?: "horizontal" | "vertical"
  decorative?: boolean
}

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: SeparatorProps) {
  return (
    <div
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      data-orientation={orientation}
      className={cn(ds.separator.root, className)}
      {...props}
    />
  )
}

export { Separator }
