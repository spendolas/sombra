// AUTO-GENERATED from tokens/sombra.ds.json — do not edit manually
// Run `npm run tokens` to regenerate

export const ds = {
  nodeCard: {
    root: "flex flex-col bg-surface-elevated rounded-md border border-edge-card relative hover:ring-1 [.react-flow\_\_node.selected_&]:shadow-[0_0_8px_2px_rgba(99,102,241,0.4)]",
    header: "flex flex-row items-center bg-surface-raised rounded-t-md border-b border-edge-subtle px-lg py-md gap-md overflow-hidden -mb-1",
    title: "text-node-title text-fg select-none flex-1",
    content: "flex flex-col p-lg gap-y-md",
    footer: "flex flex-col items-center border-t border-edge px-lg pt-md pb-lg gap-y-md overflow-hidden",
  },
  floatingPreview: {
    root: "flex flex-col bg-overlay-scrim rounded-md border border-edge fixed z-40 overflow-hidden shadow-[0_8px_24px_0px_rgba(0,0,0,0.5)]",
  },
  fullWindowOverlay: {
    root: "flex flex-col bg-overlay-scrim fixed z-50 overflow-hidden inset-0",
  },
  nodePalette: {
    root: "flex flex-col bg-surface-alt p-xl gap-xs overflow-hidden",
    categoryGroup: "flex flex-col gap-lg",
    itemList: "flex flex-col gap-xs",
  },
  propertiesPanel: {
    root: "flex flex-col bg-surface-alt p-xl gap-xl overflow-hidden",
    nodeInfo: "flex flex-col bg-surface-raised rounded-md border border-edge p-lg gap-md",
    portRow: "flex flex-row justify-between bg-surface-raised rounded-sm px-md py-xs",
    paramSection: "flex flex-col bg-surface-raised rounded-md border border-edge p-lg gap-lg",
    sectionHeader: "text-section text-fg-dim",
    emptyText: "text-body text-fg-muted",
    errorText: "text-body text-red-400",
    categoryMeta: "text-category-meta text-fg-subtle",
    nodeTitle: "text-node-title text-fg",
    description: "text-description text-fg-dim",
    nodeIdText: "text-mono-id text-fg-muted",
    portList: "flex flex-col gap-xs",
    portLabel: "text-fg-dim",
    portTypeText: "text-mono-value text-fg-muted",
  },
  zoomBar: {
    root: "flex flex-row items-center bg-surface-alt rounded-md p-xs gap-xs text-body text-fg-dim overflow-hidden",
  },
  previewToolbar: {
    root: "flex flex-row items-start bg-surface-alt rounded-md p-xs gap-xs text-body text-fg-dim overflow-hidden",
    wrapper: "flex flex-row items-start gap-md",
  },
  paletteItem: {
    root: "flex flex-row items-center bg-surface-raised rounded-sm border border-edge-subtle px-md py-sm text-body text-fg-dim cursor-move transition-colors overflow-hidden hover:bg-surface-elevated hover:text-fg",
  },
  categoryHeader: {
    root: "flex flex-row items-center pb-md text-category text-fg-subtle overflow-hidden",
  },
  button: {
    root: "flex flex-col items-center justify-center bg-surface-alt rounded-sm border border-edge size-btn-md",
    solid: "flex flex-col items-center justify-center bg-surface-alt rounded-sm border border-edge text-fg-dim cursor-pointer transition-colors hover:bg-surface-raised hover:text-fg",
    solidDisabled: "flex flex-col items-center justify-center bg-surface-alt rounded-sm border border-edge text-fg-muted cursor-default",
    solidActive: "flex flex-col items-center justify-center bg-indigo rounded-sm text-fg cursor-default",
    ghost: "flex flex-col items-center justify-center rounded-sm text-fg-dim cursor-pointer transition-colors hover:bg-surface-elevated hover:text-fg",
    ghostDisabled: "flex flex-col items-center justify-center rounded-sm text-fg-muted cursor-default",
    ghostActive: "flex flex-col items-center justify-center bg-indigo rounded-sm text-fg cursor-default hover:bg-indigo",
    textGhost: "flex flex-col items-center justify-center rounded-sm px-sm text-mono-value text-fg-dim cursor-pointer transition-colors hover:bg-surface-elevated hover:text-fg h-btn-md w-auto px-sm",
    textGhostDisabled: "flex flex-col items-center justify-center rounded-sm px-sm text-mono-value text-fg-muted cursor-default h-btn-md w-auto px-sm",
    textGhostActive: "flex flex-col items-center justify-center bg-indigo rounded-sm px-sm text-mono-value text-fg cursor-default hover:bg-indigo h-btn-md w-auto px-sm",
    solidHover: "flex flex-col items-center justify-center bg-surface-raised rounded-sm border border-edge text-fg cursor-pointer",
    ghostHover: "flex flex-col items-center justify-center bg-surface-elevated rounded-sm text-fg cursor-pointer",
    textGhostHover: "flex flex-col items-center justify-center bg-surface-elevated rounded-sm px-sm text-mono-value text-fg cursor-pointer h-btn-md w-auto px-sm",
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
    root: "flex flex-row items-center pr-lg gap-sm relative flex",
    label: "text-handle text-fg px-handle-offset flex-1",
  },
  floatSlider: {
    root: "flex flex-col gap-2xs select-none overflow-hidden nodrag nowheel nokey",
    labelRow: "flex flex-row items-center gap-xs cursor-ew-resize overflow-hidden",
    label: "text-param text-fg-subtle",
    value: "text-body text-fg cursor-text tabular-nums",
    input: "text-body text-fg bg-transparent text-right tabular-nums outline-none border-b border-indigo nodrag nowheel",
  },
  enumSelect: {
    root: "flex flex-col gap-sm overflow-hidden",
    label: "text-param text-fg-subtle",
    trigger: "flex flex-row items-center justify-between bg-surface-raised rounded-sm border border-edge p-md text-body text-fg w-full h-select-h",
    content: "bg-surface-elevated border border-edge",
    item: "text-body",
  },
  colorInput: {
    root: "flex flex-col gap-sm overflow-hidden",
    label: "text-param text-fg-subtle",
    input: "bg-surface-alt rounded-sm border border-edge cursor-pointer w-full h-input-h",
  },
  connectableParamRow: {
    root: "flex flex-row items-center relative",
    innerFrame: "flex flex-col pl-handle-offset pr-xs gap-xs overflow-hidden h-[36px] flex-1",
  },
  gradientEditor: {
    root: "flex flex-col gap-md",
    bar: "rounded-md border border-edge cursor-crosshair relative h-input-h",
    stopMarkers: "relative h-icon-sm",
    stopHandle: "bg-overlay-scrim rounded-full border-2 border-surface-elevated cursor-pointer absolute w-handle h-handle",
    stopHandleSelected: "bg-fg border-2 border-surface-elevated shadow-[0_0_4px_1px_rgba(99,102,241,0.8)]",
    controlsRow: "flex flex-row items-center gap-md overflow-hidden",
    positionText: "text-param text-fg-dim tabular-nums",
  },
  randomDisplay: {
    root: "flex flex-row items-center px-xs gap-md overflow-hidden nodrag nowheel",
    value: "text-mono-value text-fg tabular-nums flex-1",
  },
  miniMap: {
    root: "bg-surface-alt rounded-md border border-edge-subtle overflow-hidden",
  },
  graphToolbar: {
    root: "flex flex-row items-center justify-center bg-surface-alt rounded-md p-xs gap-xs text-fg-dim",
  },
  previewPanel: {
    root: "flex flex-col bg-overlay-scrim relative overflow-hidden w-full h-full",
  },
  icon: {
    root: "flex flex-col items-center justify-center",
  },
  textGhostButton: {
    root: "flex flex-col items-center justify-center rounded-sm",
  },
  selectFrame: {
    root: "flex flex-row items-center justify-between bg-surface-raised rounded-sm border border-edge px-md py-md",
  },
  colorSwatch: {
    root: "bg-surface-alt rounded-sm border border-edge w-6 h-6",
  },
  nodeParameters: {
    root: "flex flex-col gap-lg",
    connectedRow: "flex flex-col gap-sm",
    connectedHeader: "flex flex-row items-center justify-between",
  },
  shaderNode: {
    errorState: "bg-surface-raised rounded-sm border border-edge px-lg py-sm text-error",
    dynamicInputRow: "flex flex-row items-center justify-center py-xs gap-md",
    dynamicInputCount: "text-param text-fg-muted",
    connectedLabel: "text-param text-fg-subtle",
    connectedSource: "text-param text-fg-muted",
    warnText: "text-fg-muted text-[10px]",
    paramDivider: "border-t border-edge-subtle w-full",
  },
} as const;

export type DSComponent = keyof typeof ds;
