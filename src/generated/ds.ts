// AUTO-GENERATED from tokens/sombra.ds.json — do not edit manually
// Run `npm run tokens` to regenerate

export const ds = {
  nodeCard: {
    root: "flex flex-col bg-surface-elevated rounded-md border border-edge-card relative hover:ring-1 [.react-flow__node.selected_&]:border-muted-foreground [.react-flow__node.selected_&]:shadow-lg",
    header: "flex flex-row items-center justify-between bg-surface-raised rounded-t-md border-b border-edge-subtle px-lg py-md gap-md -mb-1",
    title: "text-node-title text-fg select-none flex-1",
    content: "flex flex-col p-lg gap-y-md",
    footer: "flex flex-col items-center border-t border-edge px-lg pt-md pb-lg gap-y-md",
  },
  floatingPreview: {
    root: "flex flex-col bg-black rounded-md border border-edge fixed z-40 overflow-hidden shadow-2xl",
  },
  fullWindowOverlay: {
    root: "bg-black fixed z-50 inset-0",
  },
  nodePalette: {
    root: "flex flex-col bg-surface-alt p-xl gap-xs",
    categoryGroup: "flex flex-col gap-lg",
    itemList: "flex flex-col gap-xs",
  },
  propertiesPanel: {
    root: "flex flex-col bg-surface-alt p-xl gap-xl",
    nodeInfo: "bg-surface-raised rounded-lg border border-edge p-lg",
    portRow: "flex flex-row justify-between bg-surface-raised rounded-sm px-md py-xs",
    paramSection: "bg-surface-raised rounded-lg border border-edge p-lg",
  },
  zoomBar: {
    root: "flex flex-row bg-surface-alt rounded-md p-xs gap-xs text-fg-dim",
  },
  previewToolbar: {
    root: "flex flex-row items-center bg-surface-alt rounded-md p-xs gap-xs text-body text-fg-dim",
    wrapper: "flex flex-row items-center gap-md",
  },
  paletteItem: {
    root: "bg-surface-raised rounded-sm border border-edge-subtle px-md py-sm text-body text-fg-dim cursor-move transition-colors hover:bg-surface-elevated hover:text-fg",
  },
  categoryHeader: {
    root: "pb-md text-category text-fg-subtle",
  },
  button: {
    root: "flex flex-col items-center justify-center rounded-sm size-btn-md",
    solid: "bg-surface-alt border border-edge text-fg-dim cursor-pointer transition-colors hover:bg-surface-raised hover:text-fg",
    solidDisabled: "text-fg-muted cursor-default",
    solidActive: "bg-indigo text-fg cursor-default",
    ghost: "text-fg-dim cursor-pointer transition-colors hover:bg-surface-elevated hover:text-fg",
    ghostDisabled: "text-fg-muted cursor-default",
    ghostActive: "bg-indigo text-fg cursor-default hover:bg-indigo",
    textGhost: "text-mono-value text-fg-dim cursor-pointer transition-colors hover:bg-surface-elevated hover:text-fg",
    textGhostDisabled: "text-mono-value text-fg-muted cursor-default",
    textGhostActive: "bg-indigo text-mono-value text-fg cursor-default hover:bg-indigo",
  },
  handle: {
    root: "rounded-full !h-3 !w-3 border-2 transition",
  },
  separator: {
    root: "bg-edge-subtle shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
  },
  sliderTrack: {
    track: "bg-surface-raised rounded-full relative w-full h-slider-track",
    fill: "bg-indigo rounded-full absolute top-0 bottom-0",
  },
  labeledHandle: {
    root: "items-center relative flex",
    label: "text-handle text-fg px-handle-offset flex-1",
  },
  floatSlider: {
    root: "flex flex-col gap-2xs select-none nodrag nowheel nokey",
    labelRow: "flex flex-row items-center justify-between cursor-ew-resize",
    label: "text-param text-fg-subtle",
    value: "text-body text-fg cursor-text tabular-nums",
    input: "text-body text-fg bg-transparent text-right tabular-nums outline-none border-b border-indigo nodrag nowheel",
  },
  enumSelect: {
    root: "flex flex-col gap-sm",
    label: "text-param text-fg-subtle",
    trigger: "bg-surface-raised rounded-sm border border-edge text-body text-fg w-full h-select-h",
    content: "bg-surface-elevated border border-edge",
    item: "text-body",
  },
  colorInput: {
    root: "flex flex-col gap-sm",
    label: "text-param text-fg-subtle",
    input: "bg-surface-raised rounded-sm border border-edge cursor-pointer w-full h-input-h",
  },
  connectableParamRow: {
    root: "flex flex-row items-center relative",
    innerFrame: "pl-handle-offset pr-xs flex-1",
  },
  gradientEditor: {
    root: "flex flex-col gap-md",
  },
  randomDisplay: {
    root: "flex flex-row items-center justify-between px-xs gap-md nodrag nowheel",
    value: "text-mono-value text-fg tabular-nums",
  },
  miniMap: {
    root: "bg-surface-alt rounded-md border border-edge-subtle",
  },
  graphToolbar: {
    root: "flex flex-row bg-surface-alt rounded-md p-xs gap-xs text-fg-dim",
  },
  previewPanel: {
    root: "bg-black relative w-full h-full",
  },
} as const;

export type DSComponent = keyof typeof ds;
