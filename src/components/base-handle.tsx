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
        "!h-3 !w-3 rounded-full border-2 transition",
        className,
      )}
      style={{
        borderColor: handleColor ?? '#6b7280',
        backgroundColor: connected ? (handleColor ?? '#6b7280') : 'var(--surface-elevated)',
        ...props.style,
      }}
    >
      {children}
    </Handle>
  );
}
