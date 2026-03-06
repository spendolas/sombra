import type { ComponentProps } from "react";
import { Handle, type HandleProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import { ds } from "@/generated/ds";
import { PORT_COLORS } from "@/utils/port-colors";

const fallback = PORT_COLORS.default;

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
      className={cn(ds.handle.root, className)}
      style={{
        borderColor: handleColor ?? fallback,
        backgroundColor: connected ? (handleColor ?? fallback) : 'var(--surface-elevated)',
        ...props.style,
      }}
    >
      {children}
    </Handle>
  );
}
