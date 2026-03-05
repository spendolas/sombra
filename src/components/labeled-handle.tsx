import { type ComponentProps } from "react";
import { type HandleProps } from "@xyflow/react";

import { cn } from "@/lib/utils";
import { BaseHandle } from "@/components/base-handle";
import { ds } from "@/generated/ds";

const flexDirections = {
  top: "flex-col",
  right: "flex-row-reverse justify-end",
  bottom: "flex-col-reverse justify-end",
  left: "flex-row",
};

export function LabeledHandle({
  className,
  labelClassName,
  handleClassName,
  title,
  position,
  handleColor,
  connected,
  ...props
}: HandleProps &
  ComponentProps<"div"> & {
    title: string;
    handleClassName?: string;
    labelClassName?: string;
    handleColor?: string;
    connected?: boolean;
  }) {
  const { ref, ...handleProps } = props;

  return (
    <div
      title={title}
      className={cn(
        ds.labeledHandle.root,
        flexDirections[position],
        className,
      )}
      ref={ref}
    >
      <BaseHandle
        position={position}
        className={handleClassName}
        handleColor={handleColor}
        connected={connected}
        {...handleProps}
      />
      <label className={cn(ds.labeledHandle.label, position === "right" && "text-right", labelClassName)}>
        {title}
      </label>
    </div>
  );
}
