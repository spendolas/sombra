// AUTO-GENERATED from tokens/sombra.ds.json — do not edit manually
// Run `npm run tokens` to regenerate

export const ds = {
  nodeCard: {
    root: "flex flex-col bg-surface-elevated rounded-md border border-edge-card",
    header: "flex flex-row items-center justify-between bg-surface-raised rounded-t-md border-b border-edge-subtle px-lg py-md gap-md",
    content: "flex flex-col p-lg gap-y-md",
    footer: "flex flex-col items-center border-t px-lg pt-md pb-lg gap-y-md",
  },
  floatingPreview: {
    root: "flex flex-col bg-black rounded-lg border border-edge shadow-2xl overflow-hidden",
  },
  fullWindowOverlay: {
    root: "bg-black",
  },
  nodePalette: {
    root: "flex flex-col bg-surface-alt p-xl gap-xs",
    categoryGroup: "flex flex-col gap-lg",
  },
  propertiesPanel: {
    root: "flex flex-col bg-surface-alt p-xl gap-xl",
    nodeInfo: "bg-surface-raised rounded-lg border border-edge p-lg",
    portRow: "flex flex-row justify-between bg-surface-raised rounded-sm px-md py-xs",
    paramSection: "bg-surface-raised rounded-lg border border-edge p-lg",
  },
  zoomBar: {
    root: "flex flex-row bg-surface-alt rounded-md p-xs gap-xs",
  },
  previewToolbar: {
    root: "flex flex-row items-center bg-surface-raised rounded-sm px-md py-xs gap-sm",
  },
  paletteItem: {
    root: "bg-surface-raised rounded-sm border border-edge-subtle px-md py-sm",
  },
  categoryHeader: {
    root: "pb-md",
  },
  plusMinusButton: {
    root: "bg-surface-alt rounded-sm border border-edge",
  },
  labeledHandle: {
    root: "flex flex-row pr-lg gap-sm",
  },
  floatSlider: {
    root: "flex flex-col gap-sm",
  },
  enumSelect: {
    root: "flex flex-col gap-sm",
    trigger: "bg-surface-raised border border-edge",
    content: "bg-surface-elevated border border-edge",
  },
  colorInput: {
    root: "flex flex-col gap-sm",
    input: "bg-surface-raised rounded-sm border border-edge",
  },
  connectableParamRow: {
    root: "flex flex-row items-center",
    innerFrame: "pl-handle-offset pr-xs flex-1",
  },
  gradientEditor: {
    root: "flex flex-col gap-md",
  },
  randomDisplay: {
    root: "flex flex-row items-center justify-between px-xs gap-md",
    button: "bg-surface-alt rounded-sm border border-edge",
  },
  miniMap: {
    root: "bg-surface-alt rounded-md border border-edge-subtle",
  },
} as const;

export type DSComponent = keyof typeof ds;
