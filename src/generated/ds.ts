// AUTO-GENERATED from tokens/sombra.ds.json — do not edit manually
// Run `npm run tokens` to regenerate

export const ds = {
  nodeCard: {
    root: "flex flex-col bg-surface-elevated rounded-md border border-edge-card relative hover:ring-1 [.react-flow__node.selected_&]:border-muted-foreground [.react-flow__node.selected_&]:shadow-lg",
    header: "flex flex-row items-center justify-between bg-surface-raised rounded-t-md border-b border-edge-subtle px-lg py-md gap-md -mb-1",
    title: "text-node-title text-fg select-none flex-1",
    content: "flex flex-col p-lg gap-y-md",
    footer: "flex flex-col items-center border-t px-lg pt-md pb-lg gap-y-md",
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
    buttonActive: "bg-indigo text-fg cursor-default hover:bg-indigo",
    buttonInactive: "text-fg-dim cursor-pointer hover:bg-surface-elevated hover:text-fg",
  },
  paletteItem: {
    root: "bg-surface-raised rounded-sm border border-edge-subtle px-md py-sm text-body text-fg-dim cursor-move transition-colors hover:bg-surface-elevated hover:text-fg",
  },
  categoryHeader: {
    root: "pb-md text-category text-fg-subtle",
  },
  plusMinusButton: {
    root: "flex flex-row items-center justify-center bg-surface-alt rounded-sm border border-edge text-param size-btn-md",
  },
  labeledHandle: {
    root: "items-center relative flex",
    label: "text-handle text-foreground px-handle-offset flex-1",
  },
  floatSlider: {
    root: "flex flex-col gap-2xs select-none nodrag nowheel nokey",
  },
  enumSelect: {
    root: "flex flex-col gap-sm",
    label: "text-param text-fg-subtle",
    trigger: "bg-surface-raised border border-edge text-body text-fg w-full h-select-h",
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
    button: "flex flex-row items-center justify-center bg-surface-alt rounded-sm border border-edge text-fg-dim cursor-pointer transition-colors hover:bg-surface-raised hover:text-fg size-btn-md",
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
