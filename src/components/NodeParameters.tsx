/**
 * NodeParameters - Generic parameter controls for shader nodes
 */

import { useCallback } from 'react'
import type { NodeParameter } from '../nodes/types'
import { useGraphStore } from '../stores/graphStore'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface NodeParametersProps {
  nodeId: string
  parameters: NodeParameter[]
  currentValues: Record<string, unknown>
}

export function NodeParameters({ nodeId, parameters, currentValues }: NodeParametersProps) {
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

  return (
    <div className="space-y-3">
      {parameters.map((param) => (
        <div key={param.id}>
          {param.type === 'float' && (
            <FloatSlider
              param={param}
              value={(currentValues[param.id] as number) ?? param.default}
              onChange={(value) => handleChange(param.id, value)}
            />
          )}
          {param.type === 'color' && (
            <ColorInput
              param={param}
              value={(currentValues[param.id] as [number, number, number]) ?? param.default}
              onChange={(value) => handleChange(param.id, value)}
            />
          )}
        </div>
      ))}
    </div>
  )
}

interface FloatSliderProps {
  param: NodeParameter
  value: number
  onChange: (value: number) => void
}

function FloatSlider({ param, value, onChange }: FloatSliderProps) {
  const min = param.min ?? 0
  const max = param.max ?? 1
  const step = param.step ?? 0.01

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <Label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {param.label}
        </Label>
        <Input
          type="number"
          value={value}
          onChange={(e) => {
            const newValue = parseFloat(e.target.value)
            if (!isNaN(newValue)) onChange(newValue)
          }}
          step={step}
          className="w-16 h-6 px-1 py-0.5 text-right text-[10px]"
        />
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(values) => onChange(values[0])}
      />
    </div>
  )
}

interface ColorInputProps {
  param: NodeParameter
  value: [number, number, number]
  onChange: (value: [number, number, number]) => void
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
    <div className="space-y-1.5">
      <Label className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        {param.label}
      </Label>
      <input
        type="color"
        value={hexColor}
        onChange={(e) => handleColorChange(e.target.value)}
        className="w-full h-6 rounded cursor-pointer"
        style={{
          border: '1px solid var(--border-primary)',
          backgroundColor: 'var(--bg-tertiary)',
        }}
      />
    </div>
  )
}
