// AUTO-GENERATED from tokens/sombra.ds.json — do not edit manually
// Run `npm run tokens` to regenerate

export const ds = {
  nodeCard: {
    root: "flex flex-col bg-surface-elevated rounded-md relative hover:ring-1 [.react-flow\_\_node.selected_&]:shadow-[0_0_8px_2px_rgba(99,102,241,0.4)]",
    header: "flex flex-row items-center bg-surface-raised rounded-t-md border-b border-edge-subtle px-lg py-md gap-md overflow-hidden h-[32px] -mb-1",
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
  actionButton: {
    secondary: "flex flex-row items-center justify-center rounded-sm border border-edge px-lg py-xs text-action text-fg-dim cursor-pointer transition-colors hover:bg-hover hover:text-fg",
    primary: "flex flex-row items-center justify-center bg-indigo rounded-sm px-lg py-xs text-action text-fg cursor-pointer transition-colors hover:bg-indigo-hover",
    primaryDisabled: "flex flex-row items-center justify-center bg-surface-raised rounded-sm px-lg py-xs text-action text-fg-muted cursor-not-allowed",
  },
  fileDropDialog: {
    root: "flex flex-col items-center justify-center bg-overlay-scrim fixed z-50 overflow-hidden inset-0",
    panel: "flex flex-col bg-surface-raised rounded-md border border-edge p-lg gap-md overflow-hidden",
    title: "text-node-title text-fg",
    detail: "text-description text-fg-dim",
    actions: "flex flex-row items-center justify-end gap-md overflow-hidden",
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
    root: "flex flex-row items-center bg-surface-alt rounded-md p-xs gap-xs text-mono-value text-fg-dim overflow-hidden",
  },
  previewToolbar: {
    root: "flex flex-row items-start bg-surface-alt rounded-md p-xs gap-xs text-body text-fg-dim overflow-hidden",
    wrapper: "flex flex-row items-start gap-md",
  },
  paletteItem: {
    root: "flex flex-row items-center px-md py-sm text-body text-fg-dim cursor-move transition-colors overflow-hidden hover:bg-highlight hover:text-fg",
  },
  categoryHeader: {
    root: "flex flex-row items-center pb-md text-category text-fg-subtle uppercase overflow-hidden",
  },
  button: {
    root: "flex flex-col items-center justify-center rounded-sm size-btn-md",
    solid: "flex flex-col items-center justify-center bg-surface-alt rounded-sm text-fg-dim cursor-pointer transition-colors hover:bg-surface-raised hover:text-fg",
    solidDisabled: "flex flex-col items-center justify-center bg-surface-alt rounded-sm text-fg-muted cursor-default",
    solidActive: "flex flex-col items-center justify-center bg-active rounded-sm text-fg cursor-default",
    ghost: "flex flex-col items-center justify-center rounded-sm text-fg-dim cursor-pointer transition-colors hover:bg-hover hover:text-fg",
    ghostDisabled: "flex flex-col items-center justify-center rounded-sm text-fg-muted cursor-default",
    ghostActive: "flex flex-col items-center justify-center bg-active rounded-sm text-fg cursor-default hover:bg-active",
    textGhost: "flex flex-col items-center justify-center rounded-sm px-sm text-mono-value text-fg-dim cursor-pointer transition-colors hover:bg-hover hover:text-fg h-btn-md w-auto px-sm",
    textGhostDisabled: "flex flex-col items-center justify-center rounded-sm px-sm text-mono-value text-fg-muted cursor-default h-btn-md w-auto px-sm",
    textGhostActive: "flex flex-col items-center justify-center bg-active rounded-sm px-sm text-mono-value text-fg cursor-default hover:bg-active h-btn-md w-auto px-sm",
    solidHover: "flex flex-col items-center justify-center bg-highlight rounded-sm text-fg cursor-pointer",
    ghostHover: "flex flex-col items-center justify-center bg-highlight rounded-sm text-fg cursor-pointer",
    textGhostHover: "flex flex-col items-center justify-center bg-highlight rounded-sm px-sm text-mono-value text-fg cursor-pointer h-btn-md w-auto px-sm",
  },
  handle: {
    root: "rounded-full !h-3 !w-3 border-2 transition",
  },
  separator: {
    root: "bg-edge-subtle shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
  },
  sliderTrack: {
    track: "bg-surface-raised rounded-full h-slider-track relative w-full",
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
    value: "text-mono-value text-fg text-center cursor-text",
    input: "text-mono-value text-fg bg-transparent text-right outline-none border-b border-indigo nodrag nowheel",
  },
  enumSelect: {
    root: "flex flex-col gap-sm overflow-hidden",
    label: "text-param text-fg-subtle",
    trigger: "flex flex-row items-center justify-between bg-surface-raised rounded-sm border border-edge p-md text-body text-fg cursor-pointer transition-colors w-full h-select-h hover:bg-highlight",
    content: "bg-surface-raised border border-edge",
    item: "text-body text-fg cursor-pointer",
  },
  colorInput: {
    root: "flex flex-col gap-sm overflow-hidden",
    label: "text-param text-fg-subtle",
  },
  connectableParamRow: {
    root: "flex flex-row items-center relative",
    innerFrame: "flex flex-col pl-handle-offset pr-xs gap-xs overflow-hidden h-[36px] flex-1",
  },
  gradientEditor: {
    root: "flex flex-col gap-md",
    bar: "bg-gradient:linear rounded-md border border-edge cursor-crosshair relative h-input-h",
    stopMarkers: "relative h-icon-sm",
    stopHandle: "bg-overlay-scrim rounded-full border-[2px] border-surface-elevated cursor-pointer transition-colors absolute w-handle h-handle hover:border-active",
    stopHandleSelected: "bg-fg border-[2px] border-surface-elevated shadow-[0_0_4px_1px_rgba(99,102,241,0.8)]",
    controlsRow: "flex flex-row items-center gap-md overflow-hidden",
    positionText: "text-mono-value text-fg text-center",
  },
  randomDisplay: {
    root: "flex flex-row items-center px-xs gap-md overflow-hidden nodrag nowheel",
    value: "text-mono-value text-fg flex-1",
  },
  miniMap: {
    root: "bg-surface-alt rounded-md overflow-hidden",
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
    root: "bg-surface-alt rounded-sm border border-edge cursor-pointer transition-colors w-6 h-6 hover:border-active",
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
  anchorGrid: {
    root: "flex flex-col gap-sm",
    label: "text-param text-fg-subtle",
    grid: "bg-surface-raised rounded-sm border border-edge p-2xs gap-2xs grid grid-cols-3 w-fit",
    cell: "flex flex-row items-center justify-center rounded-xs cursor-pointer transition-colors w-icon-md h-icon-md hover:bg-highlight",
    cellActive: "flex flex-row items-center justify-center bg-indigo rounded-xs cursor-pointer transition-colors w-icon-md h-icon-md hover:bg-indigo-hover",
    dot: "bg-fg-muted size-1.5 rounded-full",
    dotActive: "bg-fg size-1.5 rounded-full",
  },
  boolCheckbox: {
    root: "flex flex-row items-center gap-sm cursor-pointer nodrag nowheel",
    box: "bg-surface-raised rounded-xs border border-edge overflow-hidden w-icon-sm h-icon-sm",
    boxChecked: "flex flex-row items-center justify-center bg-indigo rounded-xs border border-edge overflow-hidden w-icon-sm h-icon-sm",
    indicator: "text-fg text-center text-[11px] leading-none",
    label: "text-param text-fg-subtle",
  },
  nodePreview: {
    root: "overflow-hidden w-full aspect-square nowheel",
  },
  imageViewportOverlay: {
    root: "overflow-hidden relative rounded-sm",
  },
  gizmo: {
    handle: "bg-white rounded-full border-[1.5px] border-indigo cursor-grab w-[12px] h-[12px]",
    center: "bg-surface rounded-full border-[1.5px] border-indigo w-[14px] h-[14px]",
    connector: "border-[1.5px] border-indigo",
  },
  colorPicker: {
    panel: "flex flex-col bg-surface-raised rounded-lg border border-edge p-lg gap-md w-[232px] shadow-[0_10px_30px_-8px_rgba(0,0,0,.6)]",
    body: "flex flex-col gap-md",
    channels: "flex flex-col gap-lg py-0.5",
    svArea: "cursor-crosshair relative w-full h-[150px] touch-none",
    svFill: "rounded-sm border border-edge absolute overflow-hidden inset-0",
    handle: "rounded-full border-[3px] border-white absolute pointer-events-none",
    slider: "rounded-full border border-edge cursor-pointer select-none relative w-full h-[14px] touch-none",
    inputRow: "flex flex-row items-center gap-sm",
    hexInput: "bg-surface-elevated rounded-md border border-edge px-md text-mono-value text-fg uppercase flex-1 min-w-0 h-8 focus:outline-none focus:border-indigo",
    swatch: "rounded-sm border border-edge cursor-pointer transition-colors relative overflow-hidden w-7 h-7 hover:border-indigo-hover focus-visible:outline-2 focus-visible:outline-indigo-hover",
    footer: "flex flex-row items-center justify-between border-t border-edge-subtle pt-md relative mt-0.5",
    formTrigger: "rounded-sm text-fg-dim cursor-pointer hover:bg-surface-elevated hover:text-fg inline-flex items-center gap-1 px-2 py-1 text-[13px] font-medium",
    menu: "flex flex-col bg-surface-raised rounded-md border border-edge p-xs absolute z-20 left-0 right-0 bottom-[calc(100%+8px)] gap-0.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,.7)]",
    menuItem: "flex flex-row items-center justify-between rounded-sm gap-md cursor-pointer px-2.5 py-2 text-[13px] text-left",
    menuItemActive: "text-indigo-hover bg-indigo/15",
    channelRow: "flex flex-col gap-sm",
    channelHead: "flex flex-row items-center justify-between",
    channelLabel: "text-fg text-[13px] font-medium",
    channelValue: "rounded-sm text-mono-value text-fg text-right hover:bg-surface-elevated w-[58px] bg-transparent border border-transparent px-1.5 py-0.5 focus:outline-none focus:border-indigo focus:bg-surface-elevated [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none",
    menuItemIdle: "text-fg-dim hover:bg-surface-elevated hover:text-fg",
  },
} as const;

export type DSComponent = keyof typeof ds;
