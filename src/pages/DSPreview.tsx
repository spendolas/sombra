/**
 * DSPreview — Design System contact sheet.
 * Renders every DS component in every state with data-ds-* attributes
 * for programmatic audit inspection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  type Node,
} from '@xyflow/react'
import type { NodeData } from '@/nodes/types'
import { ALL_NODES } from '@/nodes'
import { estimateNodeSize } from '@/utils/layout'
import { useGraphStore } from '@/stores/graphStore'
import { ShaderNode } from '@/components/ShaderNode'
import { NodePalette } from '@/components/NodePalette'
import { PropertiesPanel } from '@/components/PropertiesPanel'
import { Separator } from '@/components/ui/separator'
import { SombraSlider } from '@/components/ui/sombra-slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { IconButton } from '@/components/IconButton'
import { icons, type IconName } from '@/components/icons'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'
import { getPortColor } from '@/utils/port-colors'

// ─── Token Definitions ──────────────────────────────────────────────────────

const COLOR_GROUPS = [
  {
    label: 'Surface',
    tokens: [
      { name: 'surface', var: '--surface' },
      { name: 'surface-alt', var: '--surface-alt' },
      { name: 'surface-raised', var: '--surface-raised' },
      { name: 'surface-elevated', var: '--surface-elevated' },
    ],
  },
  {
    label: 'Foreground',
    tokens: [
      { name: 'fg', var: '--fg' },
      { name: 'fg-dim', var: '--fg-dim' },
      { name: 'fg-subtle', var: '--fg-subtle' },
      { name: 'fg-muted', var: '--fg-muted' },
    ],
  },
  {
    label: 'Edge',
    tokens: [
      { name: 'edge', var: '--edge' },
      { name: 'edge-subtle', var: '--edge-subtle' },
      { name: 'edge-card', var: '--edge-card' },
    ],
  },
  {
    label: 'Indigo',
    tokens: [
      { name: 'indigo', var: '--indigo' },
      { name: 'indigo-hover', var: '--indigo-hover' },
      { name: 'indigo-active', var: '--indigo-active' },
    ],
  },
  {
    label: 'Special',
    tokens: [
      { name: 'overlay-scrim', var: '--overlay-scrim' },
      { name: 'error', var: '--error' },
    ],
  },
]

const SPACING_TOKENS = [
  { name: '2xs', var: '--sp-2xs' },
  { name: 'xs', var: '--sp-xs' },
  { name: 'sm', var: '--sp-sm' },
  { name: 'md', var: '--sp-md' },
  { name: 'lg', var: '--sp-lg' },
  { name: 'xl', var: '--sp-xl' },
  { name: '2xl', var: '--sp-2xl' },
  { name: 'handle-offset', var: '--handle-offset' },
]

const RADIUS_TOKENS = [
  { name: 'xs', var: '--radius-xs' },
  { name: 'sm', var: '--radius-sm' },
  { name: 'md', var: '--radius-md' },
  { name: 'lg', var: '--radius-lg' },
  { name: 'full', var: '--radius-full' },
]

const SIZE_TOKENS = [
  { name: 'handle', var: '--sz-handle' },
  { name: 'icon-sm', var: '--sz-icon-sm' },
  { name: 'icon-md', var: '--sz-icon-md' },
  { name: 'btn-sm', var: '--sz-btn-sm' },
  { name: 'btn-md', var: '--sz-btn-md' },
  { name: 'input-h', var: '--sz-input-h' },
  { name: 'select-h', var: '--sz-select-h' },
  { name: 'slider-track', var: '--sz-slider-track' },
  { name: 'slider-thumb', var: '--sz-slider-thumb' },
  { name: 'node-min-w', var: '--sz-node-min-w' },
  { name: 'input-w', var: '--sz-input-w' },
]

const TEXT_STYLES = [
  { name: 'text-node-title', class: 'text-node-title', specs: '14px / 600 / 1.5' },
  { name: 'text-section', class: 'text-section', specs: '12px / 600 / 0.05em / uppercase' },
  { name: 'text-category', class: 'text-category', specs: '10px / 600 / 0.05em / uppercase' },
  { name: 'text-body', class: 'text-body', specs: '12px / 400 / 1.5' },
  { name: 'text-description', class: 'text-description', specs: '12px / 400 / 1.625' },
  { name: 'text-handle', class: 'text-handle', specs: '13px / 400 / 1.5' },
  { name: 'text-param', class: 'text-param', specs: '10px / 400 / 1.5' },
  { name: 'text-category-meta', class: 'text-category-meta', specs: '10px / 400 / 0.025em / uppercase' },
  { name: 'text-mono-value', class: 'text-mono-value', specs: '12px / 400 / 1.5' },
  { name: 'text-mono-id', class: 'text-mono-id', specs: '10px / 400 / 1.5' },
  { name: 'text-port-type', class: 'text-port-type', specs: '11px / 400 / 1.5' },
]

const SHADOW_STYLES = [
  { name: 'node-selected', value: '0 0 8px 2px rgba(99,102,241,0.4)' },
  { name: 'floating-preview', value: '0 8px 24px 0px rgba(0,0,0,0.5)' },
  { name: 'stop-handle-selected', value: '0 0 4px 1px rgba(99,102,241,0.8)' },
]

const PORT_TYPE_NAMES: { name: string; type: string }[] = [
  { name: 'float', type: 'float' },
  { name: 'vec2', type: 'vec2' },
  { name: 'vec3', type: 'vec3' },
  { name: 'vec4', type: 'vec4' },
  { name: 'color', type: 'color' },
  { name: 'sampler2D', type: 'sampler2D' },
  { name: 'default', type: 'untyped' },
]

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function resolveVarPx(name: string): number {
  const raw = resolveVar(name)
  return parseFloat(raw) || 0
}

// ─── Layout Components ──────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-16">
      <h2 className="text-xl font-semibold text-fg mb-6 pb-2 border-b border-edge">{title}</h2>
      {children}
    </section>
  )
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h3 className="text-sm font-semibold text-fg-dim mb-4 uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  )
}

function Cell({
  dsComponent,
  dsVariant,
  label,
  children,
  className,
}: {
  dsComponent: string
  dsVariant: string
  label?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-ds-component={dsComponent}
      data-ds-variant={dsVariant}
      className={cn('flex flex-col gap-2 items-start', className)}
    >
      {children}
      {label !== undefined && (
        <span className="text-[10px] text-fg-muted mt-1">{label}</span>
      )}
    </div>
  )
}

// ─── Foundation Section ─────────────────────────────────────────────────────

function FoundationSection() {
  const [resolved, setResolved] = useState<Record<string, string>>({})

  useEffect(() => {
    const values: Record<string, string> = {}
    // Colors
    for (const group of COLOR_GROUPS) {
      for (const t of group.tokens) {
        values[t.var] = resolveVar(t.var)
      }
    }
    // Spacing
    for (const t of SPACING_TOKENS) values[t.var] = resolveVar(t.var)
    // Radius
    for (const t of RADIUS_TOKENS) values[t.var] = resolveVar(t.var)
    // Sizes
    for (const t of SIZE_TOKENS) values[t.var] = resolveVar(t.var)
    setResolved(values)
  }, [])

  const hasError = (varName: string) => !resolved[varName]

  return (
    <Section title="Foundation">
      {/* Colors */}
      <SubSection title="Colors">
        {COLOR_GROUPS.map((group) => (
          <div key={group.label} className="mb-6">
            <h4 className="text-xs text-fg-subtle mb-3">{group.label}</h4>
            <div className="flex flex-wrap gap-4">
              {group.tokens.map((t) => (
                <Cell
                  key={t.name}
                  dsComponent="foundation-color"
                  dsVariant={t.name}
                  className="items-center"
                >
                  {hasError(t.var) ? (
                    <div className="w-12 h-12 rounded-sm bg-red-900 border border-red-500 flex items-center justify-center text-[8px] text-red-300">ERR</div>
                  ) : (
                    <div
                      className="w-12 h-12 rounded-sm border border-edge"
                      style={{ backgroundColor: `var(${t.var})` }}
                    />
                  )}
                  <span className="text-[10px] text-fg-dim">{t.name}</span>
                  <span className="text-[9px] text-fg-muted font-mono">{resolved[t.var] || '???'}</span>
                </Cell>
              ))}
            </div>
          </div>
        ))}
      </SubSection>

      {/* Typography */}
      <SubSection title="Typography">
        <div className="flex flex-col gap-4">
          {TEXT_STYLES.map((t) => (
            <Cell key={t.name} dsComponent="foundation-typography" dsVariant={t.name}>
              <span className={cn(t.class, 'text-fg')}>The quick brown fox jumps over the lazy dog</span>
              <span className="text-[10px] text-fg-muted">
                {t.name} — {t.specs}
              </span>
            </Cell>
          ))}
        </div>
      </SubSection>

      {/* Spacing */}
      <SubSection title="Spacing">
        <div className="flex flex-col gap-3">
          {SPACING_TOKENS.map((t) => (
            <Cell key={t.name} dsComponent="foundation-spacing" dsVariant={t.name}>
              <div className="flex items-center gap-3">
                <div
                  className="h-3 bg-indigo rounded-sm"
                  style={{ width: `var(${t.var})` }}
                />
                <span className="text-[10px] text-fg-dim min-w-[100px]">{t.name}</span>
                <span className="text-[10px] text-fg-muted font-mono">{resolved[t.var] || '???'}</span>
              </div>
            </Cell>
          ))}
        </div>
      </SubSection>

      {/* Radii */}
      <SubSection title="Radii">
        <div className="flex flex-wrap gap-4">
          {RADIUS_TOKENS.map((t) => (
            <Cell key={t.name} dsComponent="foundation-radius" dsVariant={t.name} className="items-center">
              <div
                className="w-12 h-12 bg-surface-raised border border-edge"
                style={{ borderRadius: `var(${t.var})` }}
              />
              <span className="text-[10px] text-fg-dim">{t.name}</span>
              <span className="text-[10px] text-fg-muted font-mono">{resolved[t.var] || '???'}</span>
            </Cell>
          ))}
        </div>
      </SubSection>

      {/* Shadows / Effect Styles */}
      <SubSection title="Shadows / Effect Styles">
        <div className="flex flex-wrap gap-4">
          {SHADOW_STYLES.map((s) => (
            <Cell key={s.name} dsComponent="foundation-shadow" dsVariant={s.name} className="items-center">
              <div
                className="w-[120px] h-12 bg-surface-elevated rounded-md"
                style={{ boxShadow: s.value }}
              />
              <span className="text-[10px] text-fg-dim">{s.name}</span>
            </Cell>
          ))}
        </div>
      </SubSection>

      {/* Sizing */}
      <SubSection title="Sizing">
        <div className="flex flex-col gap-3">
          {SIZE_TOKENS.map((t) => {
            const px = resolveVarPx(t.var)
            // For tokens smaller than 30px, show as a square; for larger, show as a bar
            const isSmall = px <= 30
            return (
              <Cell key={t.name} dsComponent="foundation-sizing" dsVariant={t.name}>
                <div className="flex items-center gap-3">
                  <div
                    className="bg-indigo rounded-sm"
                    style={isSmall
                      ? { width: `var(${t.var})`, height: `var(${t.var})` }
                      : { width: `var(${t.var})`, height: '16px' }
                    }
                  />
                  <span className="text-[10px] text-fg-dim min-w-[100px]">{t.name}</span>
                  <span className="text-[10px] text-fg-muted font-mono">{resolved[t.var] || '???'}</span>
                </div>
              </Cell>
            )
          })}
        </div>
      </SubSection>
    </Section>
  )
}

// ─── Atoms Section ──────────────────────────────────────────────────────────

function AtomsSection() {
  return (
    <Section title="Atoms">
      {/* Separator */}
      <SubSection title="Separator">
        <div className="flex gap-8 items-center">
          <Cell dsComponent="separator" dsVariant="horizontal" label="horizontal" className="w-48">
            <Separator orientation="horizontal" />
          </Cell>
          <Cell dsComponent="separator" dsVariant="vertical" label="vertical" className="h-12">
            <Separator orientation="vertical" />
          </Cell>
        </div>
      </SubSection>

      {/* Icons */}
      <SubSection title="Icon">
        <div className="flex flex-wrap gap-4">
          {(Object.keys(icons) as IconName[]).map((name) => {
            const Icon = icons[name]
            return (
              <Cell key={name} dsComponent="icon" dsVariant={name} label={name} className="items-center">
                <div className={ds.icon.root}>
                  <Icon className="size-icon-sm text-fg-dim" />
                </div>
              </Cell>
            )
          })}
        </div>
      </SubSection>

      {/* Button variants */}
      <SubSection title="Button">
        <div className="flex flex-wrap gap-4">
          {([
            ['solid', ds.button.solid],
            ['solidHover', ds.button.solidHover],
            ['solidActive', ds.button.solidActive],
            ['solidDisabled', ds.button.solidDisabled],
            ['ghost', ds.button.ghost],
            ['ghostHover', ds.button.ghostHover],
            ['ghostActive', ds.button.ghostActive],
            ['ghostDisabled', ds.button.ghostDisabled],
            ['textGhost', ds.button.textGhost],
            ['textGhostHover', ds.button.textGhostHover],
            ['textGhostActive', ds.button.textGhostActive],
            ['textGhostDisabled', ds.button.textGhostDisabled],
          ] as [string, string][]).map(([variant, cls]) => (
            <Cell key={variant} dsComponent="button" dsVariant={variant} label={variant} className="items-center">
              {variant.startsWith('textGhost') ? (
                <button className={cn(ds.button.root, ds.textGhostButton.root, cls)}>100%</button>
              ) : (
                <IconButton icon="plus" className={cls} />
              )}
            </Cell>
          ))}
        </div>
      </SubSection>

      {/* textGhostButton */}
      <SubSection title="textGhostButton">
        <div className="flex gap-4">
          <Cell dsComponent="textGhostButton" dsVariant="default" label="default">
            <div className={cn(ds.textGhostButton.root, ds.button.textGhost, 'px-sm h-btn-md')}>100%</div>
          </Cell>
        </div>
      </SubSection>

      {/* colorSwatch */}
      <SubSection title="colorSwatch">
        <div className="flex flex-wrap gap-4">
          {[
            ['indigo', '#6366f1'],
            ['red', '#ef4444'],
            ['green', '#22c55e'],
            ['black', '#000000'],
            ['white', '#ffffff'],
          ].map(([name, color]) => (
            <Cell key={name} dsComponent="colorSwatch" dsVariant={name} label={name} className="items-center">
              <div className={ds.colorSwatch.root} style={{ backgroundColor: color }} />
            </Cell>
          ))}
        </div>
      </SubSection>

      {/* selectFrame */}
      <SubSection title="selectFrame">
        <Cell dsComponent="selectFrame" dsVariant="default" label="default" className="w-48">
          <div className={ds.selectFrame.root}>
            <span className="text-body text-fg">Option</span>
            <span className="text-fg-muted">&#x25BE;</span>
          </div>
        </Cell>
      </SubSection>

      {/* sliderTrack */}
      <SubSection title="sliderTrack">
        <div className="flex flex-col gap-3 w-48">
          {[0, 25, 50, 75, 100].map((pct) => (
            <Cell key={pct} dsComponent="sliderTrack" dsVariant={`${pct}pct`} label={`${pct}%`}>
              <div className={ds.sliderTrack.track}>
                <div className={cn(ds.sliderTrack.fill, 'left-0')} style={{ width: `${pct}%` }} />
              </div>
            </Cell>
          ))}
        </div>
      </SubSection>

      {/* randomDisplay */}
      <SubSection title="randomDisplay">
        <Cell dsComponent="randomDisplay" dsVariant="default" label="default">
          <div className={ds.randomDisplay.root}>
            <span className={ds.randomDisplay.value}>0.7382941</span>
            <IconButton icon="shuffle" className={ds.button.solid} />
          </div>
        </Cell>
      </SubSection>

      {/* categoryHeader */}
      <SubSection title="categoryHeader">
        <Cell dsComponent="categoryHeader" dsVariant="default" label="default">
          <h3 className={ds.categoryHeader.root}>INPUTS</h3>
        </Cell>
      </SubSection>

      {/* paletteItem */}
      <SubSection title="paletteItem">
        <div className="flex gap-4">
          <Cell dsComponent="paletteItem" dsVariant="default" label="default">
            <div className={ds.paletteItem.root}>Noise</div>
          </Cell>
        </div>
      </SubSection>
    </Section>
  )
}

// ─── Molecules Section ──────────────────────────────────────────────────────

function MoleculesSection() {
  const [enumVal, setEnumVal] = useState('simplex')
  const [sliderVal, setSliderVal] = useState<number>(0.5)
  const handleSliderChange = (v: number | [number, number]) => {
    if (typeof v === 'number') setSliderVal(v)
  }

  return (
    <Section title="Molecules">
      {/* enumSelect */}
      <SubSection title="enumSelect">
        <div className="flex gap-6">
          <Cell dsComponent="enumSelect" dsVariant="closed" label="closed" className="w-48">
            <div className={ds.enumSelect.root}>
              <label className={ds.enumSelect.label}>Noise Type</label>
              <Select value={enumVal} onValueChange={setEnumVal}>
                <SelectTrigger size="sm" className={ds.enumSelect.trigger}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={ds.enumSelect.content}>
                  <SelectItem value="simplex" className={ds.enumSelect.item}>Simplex</SelectItem>
                  <SelectItem value="value" className={ds.enumSelect.item}>Value</SelectItem>
                  <SelectItem value="worley" className={ds.enumSelect.item}>Worley</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Cell>
        </div>
      </SubSection>

      {/* colorInput */}
      <SubSection title="colorInput">
        <Cell dsComponent="colorInput" dsVariant="default" label="default" className="w-48">
          <div className={ds.colorInput.root}>
            <label className={ds.colorInput.label}>Color</label>
            <input type="color" defaultValue="#6366f1" className={ds.colorInput.input} />
          </div>
        </Cell>
      </SubSection>

      {/* floatSlider */}
      <SubSection title="floatSlider">
        <div className="flex flex-col gap-4 w-48">
          <Cell dsComponent="floatSlider" dsVariant="default" label="default (0.50)">
            <SombraSlider label="Scale" value={sliderVal} onChange={handleSliderChange} min={0} max={1} step={0.01} defaultValue={0.5} />
          </Cell>
          <Cell dsComponent="floatSlider" dsVariant="min" label="at 0.00">
            <SombraSlider label="Intensity" value={0} onChange={() => {}} min={0} max={1} step={0.01} />
          </Cell>
          <Cell dsComponent="floatSlider" dsVariant="max" label="at 1.00">
            <SombraSlider label="Brightness" value={1} onChange={() => {}} min={0} max={1} step={0.01} />
          </Cell>
          <Cell dsComponent="floatSlider" dsVariant="disabled" label="disabled">
            <SombraSlider label="Locked" value={0.3} onChange={() => {}} min={0} max={1} step={0.01} disabled />
          </Cell>
        </div>
      </SubSection>

      {/* connectableParamRow */}
      <SubSection title="connectableParamRow">
        <div className="flex flex-col gap-4 w-56">
          <Cell dsComponent="connectableParamRow" dsVariant="unwired" label="unwired (with slider)">
            <div className={ds.connectableParamRow.root}>
              <div
                className={ds.handle.root}
                style={{
                  borderColor: getPortColor('float'),
                  backgroundColor: 'var(--surface-elevated)',
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                }}
              />
              <div className={ds.connectableParamRow.innerFrame}>
                <SombraSlider label="Scale" value={5} onChange={() => {}} min={1} max={20} step={0.1} />
              </div>
            </div>
          </Cell>
          <Cell dsComponent="connectableParamRow" dsVariant="wired" label="wired (with source label)">
            <div className={ds.connectableParamRow.root}>
              <div
                className={ds.handle.root}
                style={{
                  borderColor: getPortColor('float'),
                  backgroundColor: getPortColor('float'),
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                }}
              />
              <div className={ds.connectableParamRow.innerFrame}>
                <div className={cn(ds.nodeParameters.connectedHeader, 'py-2xs')}>
                  <span className={ds.shaderNode.connectedLabel}>scale</span>
                  <span className={ds.shaderNode.connectedSource}>{'← Float Constant'}</span>
                </div>
              </div>
            </div>
          </Cell>
        </div>
      </SubSection>

      {/* handle */}
      <SubSection title="handle">
        <div className="flex flex-wrap gap-4">
          {PORT_TYPE_NAMES.map(({ name, type }) => {
            const color = getPortColor(type)
            return (
              <div key={name} className="flex flex-col gap-2">
                <span className="text-[10px] text-fg-subtle">{name}</span>
                <div className="flex gap-3">
                  <Cell dsComponent="handle" dsVariant={`${name}-disconnected`} label="disconnected" className="items-center">
                    <div
                      className={ds.handle.root}
                      style={{
                        borderColor: color,
                        backgroundColor: 'var(--surface-elevated)',
                        width: 12,
                        height: 12,
                      }}
                    />
                  </Cell>
                  <Cell dsComponent="handle" dsVariant={`${name}-connected`} label="connected" className="items-center">
                    <div
                      className={ds.handle.root}
                      style={{
                        borderColor: color,
                        backgroundColor: color,
                        width: 12,
                        height: 12,
                      }}
                    />
                  </Cell>
                </div>
              </div>
            )
          })}
        </div>
      </SubSection>

      {/* labeledHandle */}
      <SubSection title="labeledHandle">
        <div className="flex gap-6">
          <Cell dsComponent="labeledHandle" dsVariant="input" label="input (left)">
            <div className={cn(ds.labeledHandle.root, 'flex-row')}>
              <div
                className={ds.handle.root}
                style={{
                  borderColor: getPortColor('vec3'),
                  backgroundColor: 'var(--surface-elevated)',
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                }}
              />
              <label className={ds.labeledHandle.label}>color</label>
            </div>
          </Cell>
          <Cell dsComponent="labeledHandle" dsVariant="output" label="output (right)">
            <div className={cn(ds.labeledHandle.root, 'flex-row-reverse justify-end')}>
              <div
                className={ds.handle.root}
                style={{
                  borderColor: getPortColor('float'),
                  backgroundColor: getPortColor('float'),
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                }}
              />
              <label className={cn(ds.labeledHandle.label, 'text-right')}>value</label>
            </div>
          </Cell>
        </div>
      </SubSection>
    </Section>
  )
}

// ─── Organisms Section ──────────────────────────────────────────────────────

const nodeTypes = { shaderNode: ShaderNode }

/**
 * Build initial node positions from estimates, then after first render
 * measure actual DOM heights and reflow to eliminate overlap.
 */
function NodeCardGrid() {
  const loadGraph = useGraphStore((s) => s.loadGraph)
  const COLS = 4
  const SPACING_X = 280
  const ROW_GAP = 40

  // Build node entries once
  const entries = useMemo(() =>
    ALL_NODES.map((def) => {
      const params: Record<string, unknown> = {}
      if (def.params) {
        for (const p of def.params) params[p.id] = p.default
      }
      const data: NodeData = { type: def.type, params }
      const est = estimateNodeSize(data)
      return { def, data, estimatedHeight: est.height }
    }), [])

  // Compute positions from a height-per-node array
  const computeLayout = useCallback((heights: number[]) => {
    const rowCount = Math.ceil(entries.length / COLS)
    const rowMaxH: number[] = []
    for (let r = 0; r < rowCount; r++) {
      let max = 0
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c
        if (idx < heights.length) max = Math.max(max, heights[idx])
      }
      rowMaxH.push(max)
    }
    const rowY: number[] = [0]
    for (let r = 1; r < rowCount; r++) {
      rowY.push(rowY[r - 1] + rowMaxH[r - 1] + ROW_GAP)
    }
    const nodes: Node<NodeData>[] = entries.map((e, i) => ({
      id: `preview-${e.def.type}`,
      type: 'shaderNode',
      position: { x: (i % COLS) * SPACING_X, y: rowY[Math.floor(i / COLS)] },
      data: e.data,
    }))
    const lastRow = rowCount - 1
    const total = rowY[lastRow] + rowMaxH[lastRow] + ROW_GAP
    return { nodes, totalHeight: total }
  }, [entries])

  // Initial layout from estimates
  const initial = useMemo(
    () => computeLayout(entries.map((e) => e.estimatedHeight)),
    [computeLayout, entries],
  )

  const [currentNodes, setCurrentNodes] = useState(initial.nodes)
  const [containerHeight, setContainerHeight] = useState(initial.totalHeight + 200)
  const hasMeasured = useRef(false)

  // Load graph on mount
  useEffect(() => {
    loadGraph(initial.nodes, [])
  }, [loadGraph, initial.nodes])

  return (
    <div
      data-ds-component="nodeCard"
      data-ds-variant="all-types"
      style={{ width: '100%', height: containerHeight }}
      className="border border-edge rounded-md overflow-hidden"
    >
      <ReactFlow
        nodes={currentNodes}
        edges={[]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onInit={() => {
          if (hasMeasured.current) return
          hasMeasured.current = true
          // Wait for nodes to render, then measure actual DOM heights
          setTimeout(() => {
            const heights = entries.map((e) => {
              const el = document.querySelector(
                `[data-id="preview-${e.def.type}"]`,
              ) as HTMLElement | null
              return el ? el.offsetHeight : e.estimatedHeight
            })
            const { nodes: reflowed, totalHeight } = computeLayout(heights)
            setCurrentNodes(reflowed)
            setContainerHeight(totalHeight + 200)
            loadGraph(reflowed, [])
          }, 100)
        }}
      >
        <MiniMap />
      </ReactFlow>
    </div>
  )
}

function OrganismsSection() {
  const nodes = useGraphStore((s) => s.nodes)
  const firstNode = nodes[0] || null

  return (
    <Section title="Organisms">
      {/* nodeCard — all 23 types in a ReactFlow grid */}
      <SubSection title="nodeCard (all 23 node types)">
        <ReactFlowProvider>
          <NodeCardGrid />
        </ReactFlowProvider>
      </SubSection>

      {/* propertiesPanel */}
      <SubSection title="propertiesPanel">
        <div className="flex gap-6">
          <Cell dsComponent="propertiesPanel" dsVariant="with-node" label="with selected node" className="w-64">
            <div className="h-[500px] overflow-y-auto">
              <PropertiesPanel selectedNode={firstNode} />
            </div>
          </Cell>
          <Cell dsComponent="propertiesPanel" dsVariant="empty" label="empty state" className="w-64">
            <PropertiesPanel selectedNode={null} />
          </Cell>
        </div>
      </SubSection>

      {/* nodePalette */}
      <SubSection title="nodePalette">
        <Cell dsComponent="nodePalette" dsVariant="default" label="default" className="w-48">
          <div className="h-[400px] overflow-y-auto">
            <NodePalette />
          </div>
        </Cell>
      </SubSection>

      {/* gradientEditor */}
      <SubSection title="gradientEditor">
        <div className="flex flex-col gap-4 w-56">
          <Cell dsComponent="gradientEditor" dsVariant="2-stop" label="2 stops">
            <div className={ds.gradientEditor.root}>
              <div
                className={ds.gradientEditor.bar}
                style={{ background: 'linear-gradient(to right, #0f0f1a, #6366f1)' }}
              />
              <div className={ds.gradientEditor.stopMarkers}>
                <div className={ds.gradientEditor.stopHandle} style={{ left: 0 }} />
                <div className={cn(ds.gradientEditor.stopHandle, ds.gradientEditor.stopHandleSelected)} style={{ left: 'calc(100% - 12px)' }} />
              </div>
              <div className={ds.gradientEditor.controlsRow}>
                <span className={ds.gradientEditor.positionText}>0.00</span>
              </div>
            </div>
          </Cell>
          <Cell dsComponent="gradientEditor" dsVariant="4-stop" label="4 stops">
            <div className={ds.gradientEditor.root}>
              <div
                className={ds.gradientEditor.bar}
                style={{ background: 'linear-gradient(to right, #0f0f1a, #252538 33%, #6366f1 66%, #e8e8f0)' }}
              />
              <div className={ds.gradientEditor.stopMarkers}>
                <div className={ds.gradientEditor.stopHandle} style={{ left: 0 }} />
                <div className={ds.gradientEditor.stopHandle} style={{ left: '33%' }} />
                <div className={cn(ds.gradientEditor.stopHandle, ds.gradientEditor.stopHandleSelected)} style={{ left: '66%' }} />
                <div className={ds.gradientEditor.stopHandle} style={{ left: 'calc(100% - 12px)' }} />
              </div>
              <div className={ds.gradientEditor.controlsRow}>
                <span className={ds.gradientEditor.positionText}>0.66</span>
              </div>
            </div>
          </Cell>
        </div>
      </SubSection>

      {/* miniMap — rendered inside the nodeCard ReactFlow above */}
      <SubSection title="miniMap">
        <Cell dsComponent="miniMap" dsVariant="default" label="(rendered inside nodeCard ReactFlow above)">
          <div className={cn(ds.miniMap.root, 'w-[200px] h-[120px]')}>
            <span className="text-[10px] text-fg-muted p-2">MiniMap (see above)</span>
          </div>
        </Cell>
      </SubSection>

      {/* zoomBar — display-only (needs useReactFlow) */}
      <SubSection title="zoomBar">
        <Cell dsComponent="zoomBar" dsVariant="default" label="default">
          <div className={cn(ds.zoomBar.root, 'flex-row')}>
            <div className="flex gap-xs flex-row">
              <IconButton icon="minus" />
              <div className="w-[140px] h-4 bg-surface-raised rounded-full" />
              <IconButton icon="plus" />
            </div>
            <button className={cn(ds.button.root, ds.textGhostButton.root, ds.button.textGhost)}>100%</button>
            <IconButton icon="maximize" />
          </div>
        </Cell>
      </SubSection>

      {/* previewToolbar */}
      <SubSection title="previewToolbar">
        <Cell dsComponent="previewToolbar" dsVariant="default" label="default">
          <div className={ds.previewToolbar.wrapper}>
            <div className={ds.previewToolbar.root}>
              <IconButton icon="rows" className={ds.button.ghostActive} />
              <IconButton icon="columns" className={ds.button.ghost} />
              <IconButton icon="pip" className={ds.button.ghost} />
            </div>
            <div className={ds.previewToolbar.root}>
              <IconButton icon="scan" className={ds.button.ghost} />
            </div>
          </div>
        </Cell>
      </SubSection>

      {/* graphToolbar */}
      <SubSection title="graphToolbar">
        <Cell dsComponent="graphToolbar" dsVariant="default" label="default">
          <div className={ds.graphToolbar.root}>
            <IconButton icon="download" />
            <IconButton icon="folderOpen" />
            <IconButton icon="share" />
          </div>
        </Cell>
      </SubSection>

      {/* previewPanel — container only */}
      <SubSection title="previewPanel">
        <Cell dsComponent="previewPanel" dsVariant="default" label="container (no WebGL)">
          <div className={cn(ds.previewPanel.root, 'w-[300px] h-[200px]')}>
            <span className="text-[10px] text-fg-muted p-4">WebGL canvas placeholder</span>
          </div>
        </Cell>
      </SubSection>

      {/* floatingPreview — container only */}
      <SubSection title="floatingPreview">
        <Cell dsComponent="floatingPreview" dsVariant="default" label="container (no WebGL)">
          <div className={cn(ds.floatingPreview.root, 'w-[300px] h-[200px]')} style={{ position: 'relative' }}>
            <span className="text-[10px] text-fg-muted p-4">Floating preview placeholder</span>
          </div>
        </Cell>
      </SubSection>

      {/* fullWindowOverlay — container only, small */}
      <SubSection title="fullWindowOverlay">
        <Cell dsComponent="fullWindowOverlay" dsVariant="default" label="container (reduced, no WebGL)">
          <div className={cn(ds.fullWindowOverlay.root, 'w-[300px] h-[200px]')} style={{ position: 'relative' }}>
            <span className="text-[10px] text-fg-muted p-4">Full window overlay placeholder</span>
          </div>
        </Cell>
      </SubSection>
    </Section>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function DSPreview() {
  // Override the global overflow:hidden on html/body/#root
  useEffect(() => {
    const root = document.getElementById('root')
    document.documentElement.style.overflow = 'auto'
    document.documentElement.style.height = 'auto'
    document.body.style.overflow = 'auto'
    document.body.style.height = 'auto'
    if (root) {
      root.style.overflow = 'auto'
      root.style.height = 'auto'
    }
  }, [])

  return (
    <div className="bg-surface min-h-screen text-fg">
      <div className="max-w-[1200px] mx-auto p-8">
        <h1 className="text-2xl font-bold text-fg mb-2">Sombra DS Contact Sheet</h1>
        <p className="text-sm text-fg-dim mb-8">
          Every component in every state. Inspect with <code className="text-fg-subtle">data-ds-component</code> / <code className="text-fg-subtle">data-ds-variant</code> attributes.
        </p>

        <FoundationSection />
        <AtomsSection />
        <MoleculesSection />
        <OrganismsSection />
      </div>
    </div>
  )
}
