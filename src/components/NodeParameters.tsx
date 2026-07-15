/**
 * NodeParameters - Generic parameter controls for shader nodes
 */

import { useCallback } from 'react'
import type { NodeParameter } from '../nodes/types'
import { useGraphStore } from '../stores/graphStore'
import { SombraSlider } from '@/components/ui/sombra-slider'
import { Label } from '@/components/ui/label'
import { RgbaColorPicker, type Rgba } from '@/components/RgbaColorPicker'
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
                value={(currentValues[param.id] as number[]) ?? param.default}
                onChange={(value) => handleChange(param.id, value)}
              />
            )}
            {param.type === 'enum' && param.options && (
              param.control === 'anchor-grid' ? (
                <AnchorGrid
                  param={param}
                  value={(currentValues[param.id] as string) ?? (param.default as string)}
                  onChange={(value) => handleChange(param.id, value)}
                />
              ) : (
                <EnumSelect
                  param={param}
                  value={(currentValues[param.id] as string) ?? param.default}
                  onChange={(value) => handleChange(param.id, value)}
                />
              )
            )}
            {param.type === 'bool' && (
              <BoolCheckbox
                param={param}
                value={(currentValues[param.id] as boolean) ?? (param.default as boolean)}
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
  value: number[]
  onChange: (value: Rgba) => void
}

interface AnchorGridProps {
  param: NodeParameter
  value: string
  onChange: (value: string) => void
}

/**
 * 3×3 pin-position toggle grid for anchor-style enum params
 * (param.control === 'anchor-grid'; options in row-major order tl..br).
 */
function AnchorGrid({ param, value, onChange }: AnchorGridProps) {
  return (
    <div className={ds.anchorGrid.root}>
      <Label className={ds.anchorGrid.label}>{param.label}</Label>
      <div className={`${ds.anchorGrid.grid} nodrag`}>
        {param.options!.map((opt) => {
          const active = opt.value === value
          return (
            <button
              key={opt.value}
              type="button"
              title={opt.label}
              aria-pressed={active}
              className={active ? ds.anchorGrid.cellActive : ds.anchorGrid.cell}
              onClick={() => onChange(opt.value)}
            >
              <span className={active ? ds.anchorGrid.dotActive : ds.anchorGrid.dot} />
            </button>
          )
        })}
      </div>
    </div>
  )
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

interface BoolCheckboxProps {
  param: NodeParameter
  value: boolean
  onChange: (value: boolean) => void
}

function BoolCheckbox({ param, value, onChange }: BoolCheckboxProps) {
  return (
    <label className={ds.boolCheckbox.root}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span className={value ? ds.boolCheckbox.boxChecked : ds.boolCheckbox.box}>
        {value && <span className={ds.boolCheckbox.indicator}>✓</span>}
      </span>
      <span className={ds.boolCheckbox.label}>{param.label}</span>
    </label>
  )
}

function ColorInput({ param, value, onChange }: ColorInputProps) {
  // Old saves may store a 3-tuple (RGB, pre-alpha-migration); pad with a=1.
  const rgba: Rgba = [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1]

  // Always inline: this renders in the Properties panel (via NodeParameters).
  // color_constant's node-body param row is suppressed in ShaderNode — its
  // own inline picker (the node body itself) is the only other consumer of
  // this param, so there is no double-render.
  return <RgbaColorPicker label={param.label} value={rgba} onChange={onChange} mode="inline" />
}
