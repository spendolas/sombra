import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";
import { ds } from "@/generated/ds";

export function BaseNode({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        ds.nodeCard.root,
        "relative",
        "hover:ring-1",
        "[.react-flow\\_\\_node.selected_&]:border-muted-foreground",
        "[.react-flow\\_\\_node.selected_&]:shadow-lg",
        className,
      )}
      tabIndex={0}
      {...props}
    />
  );
}

/**
 * A container for a consistent header layout intended to be used inside the
 * `<BaseNode />` component.
 */
export function BaseNodeHeader({
  className,
  ...props
}: ComponentProps<"header">) {
  return (
    <header
      {...props}
      className={cn(ds.nodeCard.header, "-mb-1", className)}
    />
  );
}

/**
 * The title text for the node. To maintain a native application feel, the title
 * text is not selectable.
 */
export function BaseNodeHeaderTitle({
  className,
  ...props
}: ComponentProps<"h3">) {
  return (
    <h3
      data-slot="base-node-title"
      className={cn("user-select-none flex-1 text-node-title", className)}
      {...props}
    />
  );
}

export function BaseNodeContent({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      data-slot="base-node-content"
      className={cn(ds.nodeCard.content, className)}
      {...props}
    />
  );
}

export function BaseNodeFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="base-node-footer"
      className={cn(ds.nodeCard.footer, className)}
      {...props}
    />
  );
}
