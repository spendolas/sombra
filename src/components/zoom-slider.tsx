"use client";

import {
  Panel,
  useViewport,
  useStore,
  useReactFlow,
  type PanelProps,
} from "@xyflow/react";

import { Slider } from "@/components/ui/slider";
import { IconButton } from "@/components/IconButton";
import { cn } from "@/lib/utils";
import { ds } from "@/generated/ds";

export function ZoomSlider({
  className,
  orientation = "horizontal",
  ...props
}: Omit<PanelProps, "children"> & {
  orientation?: "horizontal" | "vertical";
}) {
  const { zoom } = useViewport();
  const { zoomTo, zoomIn, zoomOut, fitView } = useReactFlow();
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);

  return (
    <Panel
      className={cn(
        ds.zoomBar.root,
        orientation === "horizontal" ? "flex-row" : "flex-col",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "flex gap-xs",
          orientation === "horizontal" ? "flex-row" : "flex-col-reverse",
        )}
      >
        <IconButton
          icon="minus"
          onClick={() => zoomOut({ duration: 300 })}
        />
        <Slider
          className={cn(
            orientation === "horizontal" ? "w-[140px]" : "h-[140px]",
          )}
          orientation={orientation}
          value={[zoom]}
          min={minZoom}
          max={maxZoom}
          step={0.01}
          onValueChange={(values) => zoomTo(values[0])}
        />
        <IconButton
          icon="plus"
          onClick={() => zoomIn({ duration: 300 })}
        />
      </div>
      <IconButton
        label={`${(100 * zoom).toFixed(0)}%`}
        className={cn(
          ds.button.textGhost,
          orientation === "horizontal"
            ? undefined
            : "h-[40px] w-[40px]",
        )}
        onClick={() => zoomTo(1, { duration: 300 })}
      />
      <IconButton
        icon="maximize"
        onClick={() => fitView({ duration: 300 })}
      />
    </Panel>
  );
}
