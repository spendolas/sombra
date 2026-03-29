/**
 * ShaderNode - Visual component for shader nodes on the canvas
 */

import { memo, useCallback, useRef, useEffect } from 'react'
import { Position, useEdges, type NodeProps } from '@xyflow/react'
import type { NodeData, NodeParameter } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { NodeParameters, FloatSlider } from './NodeParameters'
import { useGraphStore } from '../stores/graphStore'
import { usePreviewStore } from '../stores/previewStore'
import { BaseNode, BaseNodeHeader, BaseNodeHeaderTitle, BaseNodeContent } from '@/components/base-node'
import { LabeledHandle } from '@/components/labeled-handle'
import { BaseHandle } from '@/components/base-handle'
import { IconButton } from '@/components/IconButton'
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
      className="w-full aspect-square nowheel"
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
  if (!param.showWhen) return true
  return Object.entries(param.showWhen).every(
    ([key, val]) => {
      const current = currentValues[key] ?? allParams.find((p) => p.id === key)?.default
      return Array.isArray(val) ? val.includes(current as string) : current === val
    }
  )
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
  const nodeData = data as NodeData
  const definition = nodeRegistry.get(nodeData.type)
  const updateNodeData = useGraphStore((state) => state.updateNodeData)
  const onEdgesChange = useGraphStore((state) => state.onEdgesChange)

  const currentValues = nodeData.params || ({} as Record<string, unknown>)

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

  // Partition: connectable params that are visible
  const connectableParams = allParams.filter(
    (p) => p.connectable && isParamVisible(p, currentValues, allParams)
  )
  const connectableIds = new Set(connectableParams.map((p) => p.id))

  // Split connectable params: framework SRT (_srt_*) vs node-specific
  const srtParams = connectableParams.filter((p) => p.id.startsWith('srt_'))
  const nodeConnectableParams = connectableParams.filter((p) => !p.id.startsWith('srt_'))

  // Pure inputs: those NOT shadowed by a connectable param
  const pureInputs = resolvedInputs.filter((inp) => !connectableIds.has(inp.id))

  // Non-connectable, visible params (enums, non-connectable floats, colors)
  const regularParams = allParams.filter(
    (p) => !p.connectable && isParamVisible(p, currentValues, allParams)
  )

  // Dynamic input flag
  const hasDynamicInputs = !!definition.dynamicInputs

  // Determine if preview should show via upstream graph traversal
  // BFS backward: if ANY always-visual node exists upstream, show preview
  const showPreview = !definition.hidePreview && (!definition.conditionalPreview || (() => {
    const visited = new Set<string>()
    const queue = edges.filter(e => e.target === id).map(e => e.source)
    while (queue.length > 0) {
      const srcId = queue.pop()!
      if (visited.has(srcId)) continue
      visited.add(srcId)
      const srcType = (allNodes.find(n => n.id === srcId)?.data as NodeData | undefined)?.type
      const srcDef = srcType ? nodeRegistry.get(srcType) : undefined
      if (!srcDef || srcDef.hidePreview) continue
      if (!srcDef.conditionalPreview) return true // found always-visual upstream
      // Conditional — keep searching its inputs
      edges.filter(e => e.target === srcId).forEach(e => queue.push(e.source))
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
  }, [showPreview]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <BaseNode className="min-w-node">
      <BaseNodeHeader>
        <BaseNodeHeaderTitle>
          {definition.label}
        </BaseNodeHeaderTitle>
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

        {/* Node connectable param rows: handle + inline slider */}
        {nodeConnectableParams.map((param) => {
          const isConnected = connectedInputs.has(param.id)

          // Resolve source info when connected
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

          return (
            <div key={param.id} className={cn(ds.connectableParamRow.root, "nodrag nowheel")}>
              <BaseHandle
                type="target"
                position={Position.Left}
                id={param.id}
                handleColor={getPortColor(param.type)}
                connected={isConnected}
              />
              <div className={ds.connectableParamRow.innerFrame}>
                {isConnected && !hasResolvedValue ? (
                  <div className={cn(ds.nodeParameters.connectedHeader, "py-2xs")}>
                    <span className={ds.shaderNode.connectedLabel}>
                      {param.label}
                    </span>
                    <span className={ds.shaderNode.connectedSource}>
                      {'← ' + sourceLabel}
                    </span>
                  </div>
                ) : (
                  <FloatSlider
                    param={param}
                    value={displayValue}
                    onChange={(value) => handleParamChange(param.id, value)}
                    disabled={isConnected}
                  />
                )}
              </div>
              {param.warnAbove != null && !isConnected && displayValue > param.warnAbove && (
                <span className={cn(ds.shaderNode.warnText, "px-sm pb-2xs")}>
                  High value — may impact performance
                </span>
              )}
            </div>
          )
        })}

        {/* Non-connectable params (enums, sliders without handles) */}
        {regularParams.length > 0 && (
          <div className={cn(ds.shaderNode.paramDivider, "mt-xs pt-md")}>
            <NodeParameters
              nodeId={id}
              parameters={regularParams}
              currentValues={currentValues}
            />
          </div>
        )}

        {/* Framework SRT transform params */}
        {srtParams.length > 0 && (
          <div className={cn(ds.shaderNode.paramDivider, "mt-xs pt-xs")}>
            <div className="px-sm pb-2xs text-fg-subtle" style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Transform</div>
            {srtParams.map((param) => {
              const isConnected = connectedInputs.has(param.id)
              const displayValue = (currentValues[param.id] as number) ?? (param.default as number)
              return (
                <div key={param.id} className={cn(ds.connectableParamRow.root, "nodrag nowheel")}>
                  <BaseHandle
                    type="target"
                    position={Position.Left}
                    id={param.id}
                    handleColor={getPortColor(param.type)}
                    connected={isConnected}
                  />
                  <div className={ds.connectableParamRow.innerFrame}>
                    <FloatSlider
                      param={param}
                      value={displayValue}
                      onChange={(value) => handleParamChange(param.id, value)}
                      disabled={isConnected}
                    />
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
            !definition.hidePreview && regularParams.length === 0 && ds.shaderNode.paramDivider,
          )}>
            <definition.component nodeId={id} data={currentValues} />
          </div>
        )}

      </BaseNodeContent>
    </BaseNode>
  )
})

ShaderNode.displayName = 'ShaderNode'
