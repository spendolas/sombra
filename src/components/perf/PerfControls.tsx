/**
 * PerfControls — the subject/backend/resolution controls for the Perf View.
 *
 * Pure controlled component: it holds no session and no measurement state. It
 * renders the current `PerfConfig`-derived selections and calls `onChange` with
 * the single field that changed; the parent applies that to the live
 * `PerfSession` via `session.update({...})`. Node ids for the isolation select
 * are passed in (the parent reads them from the graph store) so this component
 * stays store-free and easy to reason about.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { ds } from '@/generated/ds'
import { PERF_SCENES } from '@/perf/scenes'
import { RESOLUTIONS, type ResolutionOption, type NodeOption } from './perf-view-config'

const LIVE = '__live__'
const ISOLATE_OFF = '__off__'

interface PerfControlsProps {
  /** Whether to render the scene/Graph picker. Off in the editor HUD, where the
   *  subject is pinned to the live current graph. Defaults to on (standalone). */
  showSubjectSelect?: boolean
  subjectKey: string // 'live' or a scene id
  backend: 'webgpu' | 'webgl2'
  width: number
  height: number
  dpr: number
  isolateNodeId: string | undefined
  /** Isolation only applies to the live graph (scene node ids don't exist in a
   *  scene subject's graph), so it is disabled while a scene is selected. */
  isolateDisabled: boolean
  nodeOptions: NodeOption[]
  onSubjectChange: (subject: { kind: 'live' } | { kind: 'scene'; sceneId: string }) => void
  onBackendChange: (backend: 'webgpu' | 'webgl2') => void
  onResolutionChange: (r: ResolutionOption) => void
  onDprChange: (dpr: number) => void
  onIsolateChange: (nodeId: string | undefined) => void
}

/** A labelled dropdown row — reuses the DS enumSelect layout. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={ds.enumSelect.root}>
      <Label className={ds.enumSelect.label}>{label}</Label>
      {children}
    </div>
  )
}

export function PerfControls(props: PerfControlsProps) {
  const {
    showSubjectSelect = true,
    subjectKey,
    backend,
    width,
    height,
    dpr,
    isolateNodeId,
    isolateDisabled,
    nodeOptions,
    onSubjectChange,
    onBackendChange,
    onResolutionChange,
    onDprChange,
    onIsolateChange,
  } = props

  const resKey = `${width}x${height}`

  return (
    <div className="flex flex-col gap-lg">
      <div className={ds.propertiesPanel.sectionHeader}>Subject</div>

      {showSubjectSelect && (
        <Field label="Graph">
          <Select
            value={subjectKey === 'live' ? LIVE : subjectKey}
            onValueChange={(v) =>
              v === LIVE ? onSubjectChange({ kind: 'live' }) : onSubjectChange({ kind: 'scene', sceneId: v })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={LIVE}>Live graph</SelectItem>
              {PERF_SCENES.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field label="Isolate node">
        <Select
          value={isolateNodeId ?? ISOLATE_OFF}
          disabled={isolateDisabled}
          onValueChange={(v) => onIsolateChange(v === ISOLATE_OFF ? undefined : v)}
        >
          <SelectTrigger className={isolateDisabled ? 'opacity-50 cursor-not-allowed' : undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ISOLATE_OFF}>Off (whole graph)</SelectItem>
            {nodeOptions.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isolateDisabled && (
          <span className={ds.propertiesPanel.categoryMeta}>Live graph only</span>
        )}
      </Field>

      <div className={ds.propertiesPanel.sectionHeader}>Render</div>

      <Field label="Backend">
        <Select value={backend} onValueChange={(v) => onBackendChange(v as 'webgpu' | 'webgl2')}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="webgpu">WebGPU</SelectItem>
            <SelectItem value="webgl2">WebGL2</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Resolution">
        <Select
          value={resKey}
          onValueChange={(v) => {
            const r = RESOLUTIONS.find((o) => `${o.width}x${o.height}` === v)
            if (r) onResolutionChange(r)
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOLUTIONS.map((r) => (
              <SelectItem key={`${r.width}x${r.height}`} value={`${r.width}x${r.height}`}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="DPR">
        <Select value={String(dpr)} onValueChange={(v) => onDprChange(Number(v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1×</SelectItem>
            <SelectItem value="2">2×</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}
