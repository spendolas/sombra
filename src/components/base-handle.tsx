import type { ComponentProps } from "react";
import { Handle, type HandleProps } from "@xyflow/react";

import { cn } from "@/lib/utils";

export type BaseHandleProps = HandleProps & {
  handleColor?: string;
  connected?: boolean;
};

export function BaseHandle({
  className,
  children,
  handleColor,
  connected,
  ...props
}: ComponentProps<typeof Handle> & { handleColor?: string; connected?: boolean }) {
  return (
    <Handle
      {...props}
      className={cn(
        "h-[11px] w-[11px] rounded-full border-2 transition",
        className,
      )}
      style={{
        borderColor: handleColor ?? '#6b7280',
        backgroundColor: connected ? (handleColor ?? '#6b7280') : 'var(--surface-elevated, #1a1a2e)',
        ...props.style,
      }}
    >
      {children}
    </Handle>
  );
}
