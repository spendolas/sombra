/**
 * NodeParameters - Generic parameter controls for shader nodes
 */

import { useCallback } from 'react'
import type { NodeParameter } from '../nodes/types'
import { useGraphStore } from '../stores/graphStore'
import { SombraSlider } from '@/components/ui/sombra-slider'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ds } from '@/generated/ds'

export interface SourceInfo {
  value: number | null
  sourceLabel: string
}

interface NodeParametersProps {
  nodeId: string
  parameters: NodeParameter[]
  currentValues: Record<string, unknown>
  connectedInputs?: Set<string>
  connectedSources?: Map<string, SourceInfo>
}

export function NodeParameters({ nodeId, parameters, currentValues, connectedInputs, connectedSources }: NodeParametersProps) {
  const updateNodeData = useGraphStore((state) => state.updateNodeData)

  const handleChange = useCallback(
    (paramId: string, value: unknown) => {
      updateNodeData(nodeId, {
        params: {
          ...currentValues,
          [paramId]: value,
        },
      })
    },
    [nodeId, currentValues, updateNodeData]
  )

  // Filter out hidden params
  const visibleParams = parameters.filter((p) => !p.hidden)

  return (
    <div className={ds.nodeParameters.root}>
      {visibleParams.map((param) => {
        const isConnected = connectedInputs?.has(param.id) ?? false
        const source = connectedSources?.get(param.id)
        return (
          <div key={param.id}>
            {param.type === 'float' && (() => {
              if (isConnected && source) {
                if (source.value !== null) {
                  return <FloatSlider param={param} value={source.value} onChange={() => {}} disabled />
                }
                return (
                  <div className={ds.nodeParameters.connectedRow}>
                    <div className={ds.nodeParameters.connectedHeader}>
                      <Label className={ds.floatSlider.label}>{param.label}</Label>
                      <span className={ds.shaderNode.connectedSource}>{'← ' + source.sourceLabel}</span>
                    </div>
                  </div>
                )
              }
              return (
                <FloatSlider
                  param={param}
                  value={(currentValues[param.id] as number) ?? param.default}
                  onChange={(value) => handleChange(param.id, value)}
                />
              )
            })()}
            {param.type === 'color' && (
              <ColorInput
                param={param}
                value={(currentValues[param.id] as [number, number, number]) ?? param.default}
                onChange={(value) => handleChange(param.id, value)}
              />
            )}
            {param.type === 'enum' && param.options && (
              <EnumSelect
                param={param}
                value={(currentValues[param.id] as string) ?? param.default}
                onChange={(value) => handleChange(param.id, value)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export interface FloatSliderProps {
  param: NodeParameter
  value: number
  onChange: (value: number) => void
  disabled?: boolean
}

export function FloatSlider({ param, value, onChange, disabled }: FloatSliderProps) {
  return (
    <SombraSlider
      label={param.label}
      value={value}
      onChange={onChange as (v: number | [number, number]) => void}
      min={param.min ?? 0}
      max={param.max ?? 1}
      step={param.step ?? 0.01}
      defaultValue={param.default as number}
      disabled={disabled}
    />
  )
}

interface ColorInputProps {
  param: NodeParameter
  value: [number, number, number]
  onChange: (value: [number, number, number]) => void
}

interface EnumSelectProps {
  param: NodeParameter
  value: string
  onChange: (value: string) => void
}

function EnumSelect({ param, value, onChange }: EnumSelectProps) {
  return (
    <div className={ds.enumSelect.root}>
      <Label className={ds.enumSelect.label}>
        {param.label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {param.options!.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ColorInput({ param, value, onChange }: ColorInputProps) {
  const [r, g, b] = value

  // Convert 0-1 float to 0-255 hex
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  const hexColor = `#${toHex(r)}${toHex(g)}${toHex(b)}`

  const handleColorChange = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    onChange([r, g, b])
  }

  return (
    <div className={ds.colorInput.root}>
      <Label className={ds.colorInput.label}>
        {param.label}
      </Label>
      <input
        type="color"
        value={hexColor}
        onChange={(e) => handleColorChange(e.target.value)}
        className={ds.colorInput.input}
      />
    </div>
  )
}
