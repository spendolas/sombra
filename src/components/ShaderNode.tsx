/**
 * ShaderNode - Visual component for shader nodes on the canvas
 */

import { memo, useCallback, useMemo, useRef, useEffect } from 'react'
import { Position, useEdges, type NodeProps } from '@xyflow/react'
import { matchesShowWhen, type NodeData, type NodeParameter } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { FloatSlider, AnchorGrid, EnumSelect, BoolCheckbox, SegmentedControl } from './NodeParameters'
import { worldOffsetToNode, nodeOffsetToWorld } from '../compiler/ir/srt'
import { useSettingsStore } from '../stores/settingsStore'
import { useGraphStore } from '../stores/graphStore'
import { usePreviewStore } from '../stores/previewStore'
import { useCompilerStore } from '../stores/compilerStore'
import { BaseNode, BaseNodeHeader, BaseNodeHeaderTitle, BaseNodeContent } from '@/components/base-node'
import { LabeledHandle } from '@/components/labeled-handle'
import { BaseHandle } from '@/components/base-handle'
import { IconButton } from '@/components/IconButton'
import { RgbaColorPicker, type Rgba } from '@/components/RgbaColorPicker'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

import { getPortColor } from '../utils/port-colors'

/**
 * Isolated preview thumbnail — subscribes to preview store independently
 * so that ImageBitmap updates don't trigger ShaderNode re-renders.
 * Draws ImageBitmap to a canvas element (zero-copy, no PNG encoding).
 */
const PREVIEW_SIZE = 80
const NodePreview = memo(({ nodeId }: { nodeId: string }) => {
  const bitmap = usePreviewStore((s) => s.previews[nodeId])
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bitmap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE)
    ctx.drawImage(bitmap, 0, 0)
  }, [bitmap])

  if (!bitmap) return null
  return (
    <canvas
      ref={canvasRef}
      width={PREVIEW_SIZE}
      height={PREVIEW_SIZE}
      className={ds.nodePreview.root}
      style={{ imageRendering: 'pixelated' }}
    />
  )
})
NodePreview.displayName = 'NodePreview'

/**
 * Check if a param is visible given current param values
 */
function isParamVisible(param: NodeParameter, currentValues: Record<string, unknown>, allParams: NodeParameter[]): boolean {
  if (param.hidden) return false
  return matchesShowWhen(param.showWhen, currentValues, allParams)
}

/**
 * Try to resolve a static float value from a source node's output.
 * Returns the value for constant sources, null for dynamic/computed sources.
 */
function resolveSourceFloat(sourceType: string, sourceParams: Record<string, unknown>): number | null {
  if (sourceType === 'float_constant') {
    return (sourceParams.value as number) ?? 1.0
  }
  return null
}

export const ShaderNode = memo(({ id, data }: NodeProps) => {
  const edges = useEdges()
  const allNodes = useGraphStore((state) => state.nodes)
  // Global coords-view switch — drives the Node-view offset-slider display.
  const gizmoView = useSettingsStore((s) => s.gizmoView)
  const nodeData = data as NodeData
  const definition = nodeRegistry.get(nodeData.type)
  const updateNodeData = useGraphStore((state) => state.updateNodeData)
  const setOutputAnchor = useGraphStore((state) => state.setOutputAnchor)
  const onEdgesChange = useGraphStore((state) => state.onEdgesChange)

  const currentValues = useMemo(
    () => nodeData.params || ({} as Record<string, unknown>),
    [nodeData.params]
  )

  const handleParamChange = useCallback(
    (paramId: string, value: unknown) => {
      updateNodeData(id, {
        params: {
          ...(nodeData.params || {}),
          [paramId]: value,
        },
      })
    },
    [id, nodeData.params, updateNodeData]
  )

  // Multi-param write in ONE update — two sequential handleParamChange calls
  // would clobber each other through the stale nodeData.params closure.
  // Used by the Node-view offset sliders (one drag writes both X and Y).
  const handleParamsChange = useCallback(
    (patch: Record<string, unknown>) => {
      updateNodeData(id, {
        params: {
          ...(nodeData.params || {}),
          ...patch,
        },
      })
    },
    [id, nodeData.params, updateNodeData]
  )

  // Dynamic input +/- handlers (must be before early return)
  const inputCount = Number(currentValues.inputCount) || 2

  const handleAddInput = useCallback(() => {
    if (inputCount >= 8) return
    updateNodeData(id, {
      params: { ...currentValues, inputCount: inputCount + 1 },
    })
  }, [id, currentValues, inputCount, updateNodeData])

  const handleRemoveInput = useCallback(() => {
    if (inputCount <= 2) return
    const newCount = inputCount - 1
    // Remove edges connected to the deleted port
    const deletedPortId = `in_${newCount}`
    const edgesToRemove = edges
      .filter((e) => e.target === id && e.targetHandle === deletedPortId)
      .map((e) => ({ id: e.id, type: 'remove' as const }))
    if (edgesToRemove.length > 0) {
      onEdgesChange(edgesToRemove)
    }
    updateNodeData(id, {
      params: { ...currentValues, inputCount: newCount },
    })
  }, [id, currentValues, inputCount, edges, updateNodeData, onEdgesChange])

  // Compile errors attributed to this node (before early return — hook order)
  const allErrors = useCompilerStore((s) => s.errors)
  const nodeErrors = useMemo(() => allErrors.filter((e) => e.nodeId === id), [allErrors, id])

  // Determine if preview should show via upstream graph traversal.
  // BFS backward: if ANY always-visual node exists upstream, show preview.
  // Computed before the early return so the animation hooks below stay
  // unconditional (rules of hooks).
  const showPreview = !!definition && !definition.hidePreview && (!definition.conditionalPreview || (() => {
    /**
     * Sources feeding a node's actual input PORTS. Connectable params are
     * deliberately excluded: wiring a scalar into a param cannot make a preview
     * meaningful. A Gaussian Blur with no Source renders black no matter what
     * drives its Radius, and following the Radius wire made it show that black
     * thumbnail as though content were upstream.
     */
    const portFedSources = (nodeId: string): string[] => {
      const data = allNodes.find(n => n.id === nodeId)?.data as NodeData | undefined
      const def = data?.type ? nodeRegistry.get(data.type) : undefined
      if (!def) return []
      const ports = def.dynamicInputs ? def.dynamicInputs(data?.params ?? {}) : def.inputs
      const portIds = new Set(ports.map(p => p.id))
      return edges
        .filter(e => e.target === nodeId && portIds.has(e.targetHandle ?? ''))
        .map(e => e.source)
    }

    const visited = new Set<string>()
    const queue = portFedSources(id)
    while (queue.length > 0) {
      const srcId = queue.pop()!
      if (visited.has(srcId)) continue
      visited.add(srcId)
      const srcType = (allNodes.find(n => n.id === srcId)?.data as NodeData | undefined)?.type
      const srcDef = srcType ? nodeRegistry.get(srcType) : undefined
      if (!srcDef || srcDef.hidePreview) continue
      if (!srcDef.conditionalPreview) return true // found always-visual upstream
      // Conditional — keep searching its inputs
      queue.push(...portFedSources(srcId))
    }
    return false
  })())

  const previewWrapperRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<number>(0)
  const mountedRef = useRef(false)

  // Animate preview expand/collapse — JS-driven for perfect sync
  useEffect(() => {
    const wrapper = previewWrapperRef.current
    if (!wrapper) return
    const baseNode = wrapper.parentElement
    if (!baseNode) return

    cancelAnimationFrame(animRef.current)

    const runAnimation = (from: number, to: number) => {
      let start = 0
      const duration = 300
      const expanding = to > from

      const tick = (now: number) => {
        if (!start) start = now
        const t = Math.min((now - start) / duration, 1)
        const e = 1 - Math.pow(1 - t, 3) // ease-out cubic
        const val = from + (to - from) * e

        wrapper.style.maxHeight = val + 'px'
        wrapper.style.opacity = String(expanding ? e : 1 - e)
        baseNode.style.marginTop = -val + 'px'

        if (t < 1) animRef.current = requestAnimationFrame(tick)
      }
      animRef.current = requestAnimationFrame(tick)
    }

    if (showPreview) {
      // Expanding — wait for canvas to render if needed
      const waitAndExpand = () => {
        const h = wrapper.scrollHeight
        if (h > 0) {
          if (!mountedRef.current) {
            // First mount: snap
            mountedRef.current = true
            wrapper.style.maxHeight = h + 'px'
            wrapper.style.opacity = '1'
            baseNode.style.marginTop = -h + 'px'
          } else {
            runAnimation(parseFloat(wrapper.style.maxHeight) || 0, h)
          }
        } else {
          // Canvas not yet rendered — poll next frame
          animRef.current = requestAnimationFrame(waitAndExpand)
        }
      }
      waitAndExpand()
    } else {
      // Collapsing
      if (!mountedRef.current) {
        mountedRef.current = true
        wrapper.style.maxHeight = '0px'
        wrapper.style.opacity = '0'
        baseNode.style.marginTop = '0px'
      } else {
        const from = parseFloat(wrapper.style.maxHeight) || 0
        if (from > 0) {
          runAnimation(from, 0)
        }
      }
    }

    return () => cancelAnimationFrame(animRef.current)
  }, [showPreview])

  if (!definition) {
    return (
      <div className={ds.shaderNode.errorState}>
        Unknown node: {nodeData.type}
      </div>
    )
  }

  const allParams = definition.params || []

  // Build sets of connected port IDs for this node
  const connectedInputs = new Set(
    edges.filter((e) => e.target === id).map((e) => e.targetHandle)
  )
  const connectedOutputs = new Set(
    edges.filter((e) => e.source === id).map((e) => e.sourceHandle)
  )

  // Resolve inputs: use dynamicInputs when available
  const resolvedInputs = definition.dynamicInputs
    ? definition.dynamicInputs(currentValues)
    : definition.inputs

  // SRT (framework transform) params render in the Transform section below.
  // NOT gated on `connectable`: non-connectable SRT params (e.g. the
  // `srt_translateSpace` enum) must render here too — the bodyParams pass
  // excludes everything `srt_`, so gating this on connectable dropped them from
  // BOTH lists and they rendered nowhere. `isParamVisible` still hides
  // `hidden:true` ones (gradient parks its SRT params that way).
  const srtParams = allParams.filter(
    (p) => p.id.startsWith('srt_') && isParamVisible(p, currentValues, allParams)
  )

  // Everything else renders inline in DECLARED ORDER, with a left handle on
  // connectable params (so all inputs are wireable). One ordered pass keeps
  // authoring order (e.g. Tile Mode before Cell Size) and lets each param pick
  // its own control — colors render as swatch pickers, not sliders.
  // color_constant's `color` param is excluded — its node body IS the inline
  // picker (rendered below), so it must not also appear as a generic row.
  const bodyParams = allParams.filter(
    (p) =>
      !p.id.startsWith('srt_') &&
      isParamVisible(p, currentValues, allParams) &&
      !(definition.type === 'color_constant' && p.type === 'color')
  )

  const connectableIds = new Set(
    allParams
      .filter((p) => p.connectable && isParamVisible(p, currentValues, allParams))
      .map((p) => p.id)
  )

  // Pure inputs: those NOT shadowed by a connectable param
  const pureInputs = resolvedInputs.filter((inp) => !connectableIds.has(inp.id))

  // Dynamic input flag
  const hasDynamicInputs = !!definition.dynamicInputs

  // color_constant: resolve the `color` param as an RGBA tuple for the
  // inline picker below (pad legacy 3-tuple saves with a=1).
  // The picker keeps a stable value internally (its resync effect keys on the
  // numeric value, not this array's identity), so a fresh array here is fine.
  const colorConstantValue: Rgba | null = (() => {
    if (definition.type !== 'color_constant') return null
    const colorParamDef = allParams.find((p) => p.id === 'color')
    const raw = (currentValues.color as number[] | undefined) ?? (colorParamDef?.default as number[] | undefined) ?? [1, 0, 1, 1]
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 1]
  })()

  // ONE STORAGE Offset Space: srt_translateX/Y always store the WORLD offset;
  // the GLOBAL coords-view switch (GizmoViewControl → settingsStore.gizmoView)
  // is a VIEW — in 'node' view the offset sliders display/edit the offset
  // along the node's rotated+scaled axes and convert back to world on write
  // (ir/srt.ts). Switching never changes the render. Raw world values are
  // shown when either offset param is wire-driven.
  const srtRotDeg = (currentValues.srt_rotate as number) ?? 0
  const srtSx = (currentValues.srt_scaleX as number) ?? (currentValues.srt_scale as number) ?? 1
  const srtSy = (currentValues.srt_scaleY as number) ?? (currentValues.srt_scale as number) ?? 1
  const offsetNodeView =
    gizmoView === 'node' &&
    // Framework-spatial only: hand-rolled SRT (reeded) stores NODE-frame
    // offsets already — converting them would double-apply the frame.
    !!definition?.spatial &&
    allParams.some((p) => p.id === 'srt_translateX' && !p.hidden) &&
    !connectedInputs.has('srt_translateX') && !connectedInputs.has('srt_translateY')
  const nodeViewOffsets = offsetNodeView
    ? worldOffsetToNode(
        (currentValues.srt_translateX as number) ?? 0,
        (currentValues.srt_translateY as number) ?? 0,
        srtRotDeg, srtSx, srtSy,
      )
    : null

  return (
    <BaseNode className={cn('min-w-node', nodeErrors.length > 0 && 'ring-2 ring-error')}>
      <BaseNodeHeader>
        <BaseNodeHeaderTitle>
          {definition.label}
        </BaseNodeHeaderTitle>
        {nodeErrors.length > 0 && (
          <span
            className="text-error text-param shrink-0"
            title={nodeErrors.map((e) => e.message).join('\n')}
          >
            ⚠︎
          </span>
        )}
      </BaseNodeHeader>
      {/* Preview: conditional nodes get animated wrapper, others render directly */}
      {!definition.hidePreview && (definition.conditionalPreview ? (
        <div
          ref={previewWrapperRef}
          className="overflow-hidden"
        >
          <NodePreview nodeId={id} />
        </div>
      ) : <NodePreview nodeId={id} />)}

      <BaseNodeContent>
        {/* Output handles (above inputs) */}
        {definition.outputs.map((output) => (
          <LabeledHandle
            key={output.id}
            type="source"
            position={Position.Right}
            id={output.id}
            title={output.label}
            handleColor={getPortColor(output.type)}
            connected={connectedOutputs.has(output.id)}
          />
        ))}

        {/* Pure input handles */}
        {pureInputs.map((input) => (
          <LabeledHandle
            key={input.id}
            type="target"
            position={Position.Left}
            id={input.id}
            title={input.label}
            handleColor={getPortColor(input.type)}
            connected={connectedInputs.has(input.id)}
          />
        ))}

        {/* +/- buttons for dynamic input nodes */}
        {hasDynamicInputs && (
          <div className={ds.shaderNode.dynamicInputRow}>
            <IconButton
              icon="minus"
              onClick={handleRemoveInput}
              disabled={inputCount <= 2}
              className={inputCount <= 2
                ? ds.button.solidDisabled
                : ds.button.solid}
            />
            <span className={ds.shaderNode.dynamicInputCount}>
              {inputCount}
            </span>
            <IconButton
              icon="plus"
              onClick={handleAddInput}
              disabled={inputCount >= 8}
              className={inputCount >= 8
                ? ds.button.solidDisabled
                : ds.button.solid}
            />
          </div>
        )}

        {/* Body params in DECLARED ORDER. Connectable → left handle (all inputs
            wireable); control by type: color = swatch picker, enum = dropdown,
            bool = checkbox, float/other = slider. nodrag/nowheel so React Flow
            doesn't eat the first pointerdown on Radix triggers / pickers. */}
        {bodyParams.length > 0 && (
          <div className={cn(ds.shaderNode.paramDivider, "mt-xs pt-md flex flex-col gap-md nodrag nowheel")}>
            {bodyParams.map((param) => {
              const connectable = !!param.connectable
              const isConnected = connectable && connectedInputs.has(param.id)

              let displayValue = (currentValues[param.id] as number) ?? (param.default as number)
              let sourceLabel = ''
              let hasResolvedValue = false
              if (isConnected) {
                const edge = edges.find((e) => e.target === id && e.targetHandle === param.id)
                if (edge) {
                  const sourceNode = allNodes.find((n) => n.id === edge.source)
                  if (sourceNode) {
                    const sourceDef = nodeRegistry.get(sourceNode.data.type)
                    sourceLabel = sourceDef?.label || sourceNode.data.type
                    const resolved = resolveSourceFloat(sourceNode.data.type, sourceNode.data.params || {})
                    if (resolved !== null) {
                      displayValue = resolved
                      hasResolvedValue = true
                    }
                  }
                }
              }

              let control
              if (isConnected && !hasResolvedValue) {
                control = (
                  <div className={cn(ds.nodeParameters.connectedHeader, "py-2xs")}>
                    <span className={ds.shaderNode.connectedLabel}>{param.label}</span>
                    <span className={ds.shaderNode.connectedSource}>{'← ' + sourceLabel}</span>
                  </div>
                )
              } else if (param.type === 'color') {
                const raw = (currentValues[param.id] as number[] | undefined) ?? (param.default as number[] | undefined) ?? [0, 0, 0, 1]
                const rgba: Rgba = [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 1]
                control = (
                  <RgbaColorPicker
                    label={param.label}
                    mode="popover"
                    value={rgba}
                    onChange={(v) => handleParamChange(param.id, v)}
                  />
                )
              } else if (param.type === 'enum' && param.options) {
                control = param.control === 'anchor-grid' ? (
                  <AnchorGrid param={param} value={(currentValues[param.id] as string) ?? (param.default as string)} onChange={(v) => nodeData.type === 'fragment_output' && param.id === 'anchor' ? setOutputAnchor(id, v) : handleParamChange(param.id, v)} />
                ) : param.control === 'segmented' ? (
                  <SegmentedControl param={param} value={(currentValues[param.id] as string) ?? (param.default as string)} onChange={(v) => handleParamChange(param.id, v)} />
                ) : (
                  <EnumSelect param={param} value={(currentValues[param.id] as string) ?? (param.default as string)} onChange={(v) => handleParamChange(param.id, v)} />
                )
              } else if (param.type === 'bool') {
                control = (
                  <BoolCheckbox param={param} value={(currentValues[param.id] as boolean) ?? (param.default as boolean)} onChange={(v) => handleParamChange(param.id, v)} />
                )
              } else {
                control = (
                  <FloatSlider param={param} value={displayValue} onChange={(value) => handleParamChange(param.id, value)} disabled={isConnected} />
                )
              }

              return (
                <div key={param.id} className={ds.connectableParamRow.root}>
                  {connectable && (
                    <BaseHandle
                      type="target"
                      position={Position.Left}
                      id={param.id}
                      handleColor={getPortColor(param.type)}
                      connected={isConnected}
                    />
                  )}
                  {/* auto-height frame (the DS innerFrame is fixed h-36, tuned for
                      sliders — it clips taller controls like dropdowns / anchor grid) */}
                  <div className="flex flex-col pl-handle-offset pr-xs gap-xs flex-1 min-w-0">
                    {control}
                    {/* Warning stacks BELOW the control. As a flex-row sibling of the
                        slider it stole horizontal space and squished it below full width. */}
                    {param.warnAbove != null && !isConnected && displayValue > param.warnAbove && (
                      <span className={cn(ds.shaderNode.warnText, "pb-2xs")}>
                        High value — may impact performance
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Framework SRT transform params */}
        {srtParams.length > 0 && (
          <div className={cn(ds.shaderNode.paramDivider, "mt-xs pt-xs")}>
            <div className="px-sm pb-2xs text-fg-subtle" style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Transform</div>
            {srtParams.map((param) => {
              const connectable = !!param.connectable
              const isConnected = connectable && connectedInputs.has(param.id)
              const displayValue = (currentValues[param.id] as number) ?? (param.default as number)
              // Control by type — mirrors bodyParams. Non-slider controls
              // (enum dropdown) get the auto-height frame; the fixed-height
              // innerFrame is tuned for sliders and clips a dropdown.
              const isSlider = param.type !== 'enum' && param.type !== 'bool'
              let control
              if (param.type === 'enum' && param.options) {
                control = param.control === 'segmented' ? (
                  <SegmentedControl param={param} value={(currentValues[param.id] as string) ?? (param.default as string)} onChange={(v) => handleParamChange(param.id, v)} />
                ) : (
                  <EnumSelect param={param} value={(currentValues[param.id] as string) ?? (param.default as string)} onChange={(v) => handleParamChange(param.id, v)} />
                )
              } else if (param.type === 'bool') {
                control = (
                  <BoolCheckbox param={param} value={(currentValues[param.id] as boolean) ?? (param.default as boolean)} onChange={(v) => handleParamChange(param.id, v)} />
                )
              } else if (nodeViewOffsets && (param.id === 'srt_translateX' || param.id === 'srt_translateY')) {
                // Node view: this slider shows/edits the offset along the
                // node's axes; one drag rewrites BOTH world params (one write —
                // see handleParamsChange).
                const isX = param.id === 'srt_translateX'
                control = (
                  <FloatSlider
                    param={param}
                    value={isX ? nodeViewOffsets.tx : nodeViewOffsets.ty}
                    onChange={(value) => {
                      const w = nodeOffsetToWorld(
                        isX ? value : nodeViewOffsets.tx,
                        isX ? nodeViewOffsets.ty : value,
                        srtRotDeg, srtSx, srtSy,
                      )
                      handleParamsChange({ srt_translateX: w.tx, srt_translateY: w.ty })
                    }}
                    disabled={isConnected}
                  />
                )
              } else {
                control = (
                  <FloatSlider param={param} value={displayValue} onChange={(value) => handleParamChange(param.id, value)} disabled={isConnected} />
                )
              }
              return (
                <div key={param.id} className={cn(ds.connectableParamRow.root, "nodrag nowheel")}>
                  {connectable && (
                    <BaseHandle
                      type="target"
                      position={Position.Left}
                      id={param.id}
                      handleColor={getPortColor(param.type)}
                      connected={isConnected}
                    />
                  )}
                  <div className={isSlider ? ds.connectableParamRow.innerFrame : "flex flex-col pl-handle-offset pr-xs gap-xs flex-1 min-w-0"}>
                    {control}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Custom component (if provided) */}
        {definition.component && (
          <div className={cn(
            "w-full",
            !definition.hidePreview && "mt-xs pt-md",
            !definition.hidePreview && bodyParams.length === 0 && ds.shaderNode.paramDivider,
          )}>
            <ErrorBoundary label={definition.type} fallback={<div className="text-fg-subtle text-xs px-2 py-1">⚠ display unavailable</div>}>
              <definition.component nodeId={id} data={currentValues} />
            </ErrorBoundary>
          </div>
        )}

        {/* Color node: the node body IS the inline picker (no swatch/popover) —
            the `color` param is excluded from regularParams above so it isn't
            also rendered as a generic NodeParameters row. */}
        {definition.type === 'color_constant' && colorConstantValue && (
          <div className={cn("w-full mt-xs pt-md", ds.shaderNode.paramDivider)}>
            <RgbaColorPicker
              mode="inline"
              value={colorConstantValue}
              onChange={(rgba) => handleParamChange('color', rgba)}
            />
          </div>
        )}

      </BaseNodeContent>
    </BaseNode>
  )
})

ShaderNode.displayName = 'ShaderNode'
