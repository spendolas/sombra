/**
 * Stack layer edits — pure, immutable, and the ONE place the layer list's
 * top-first order meets the stored bottom-first order.
 *
 * `params.layers` is stored BOTTOM-FIRST (index 0 composites first; see
 * stack.ts). The layer list UI shows and reports layers TOP-FIRST (Photoshop
 * order). `toTopFirst` and the reorder below are the only places that flip
 * between the two; everything that displays or reorders goes through them, so
 * an off-by-one cannot appear in one direction and not the other.
 *
 * Every edit returns NEW params and a NEW edge list; nothing here mutates its
 * inputs. Undo snapshots are shallow, so an in-place `layers[i].x = y` would
 * rewrite every snapshot that shares the array. The graph store applies an
 * edit's params and edges in a single `set` with one history entry.
 */

import type { Edge } from '@xyflow/react'
import type { EdgeData } from '../types'
import { getLayers, layerPortId, maskParamId, opacityParamId, type StackLayer } from './stack'
import { isBlendMode, type BlendMode } from '../shared/blend-modes'

export type StackEdit =
  | { kind: 'add' }
  | { kind: 'remove'; id: string }
  /** Indices are TOP-FIRST, exactly as the layer list reports them: move the
   *  layer at `from` so it ends up at `to` in the resulting top-first list. */
  | { kind: 'reorder'; from: number; to: number }
  | { kind: 'toggleVisible'; id: string }
  | { kind: 'blend'; id: string; blendMode: BlendMode }

export interface StackEditResult {
  params: Record<string, unknown>
  edges: Edge<EdgeData>[]
  /** False when the edit was a no-op (unknown id, out-of-range move, same mode). */
  changed: boolean
}

/** The stored (bottom-first) layers in display order: topmost first. */
export function toTopFirst<T>(bottomFirst: readonly T[]): T[] {
  return [...bottomFirst].reverse()
}

/** The three handles a layer owns. */
export const layerHandleIds = (id: string) => [layerPortId(id), opacityParamId(id), maskParamId(id)]

/** A fresh layer id: alphanumeric (it becomes part of uniform names), unused on this node. */
export function newLayerId(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = `l${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`
    if (!taken.has(id)) return id
  }
}

export function applyStackEdit(
  nodeId: string,
  params: Record<string, unknown>,
  edges: readonly Edge<EdgeData>[],
  edit: StackEdit,
  random: () => number = Math.random,
): StackEditResult {
  const layers = getLayers(params)
  const same: StackEditResult = { params, edges: [...edges], changed: false }

  switch (edit.kind) {
    case 'add': {
      const next = Number(params.nextLayerNumber)
      const number = Number.isFinite(next) && next >= 1 ? Math.floor(next) : layers.length + 1
      const layer: StackLayer = {
        id: newLayerId(new Set(layers.map((l) => l.id)), random),
        name: `Layer ${number}`,
        blendMode: 'normal',
        visible: true,
      }
      // New layers land on TOP — the end of the bottom-first array — where the
      // list's "+" sits.
      return { params: { ...params, layers: [...layers, layer], nextLayerNumber: number + 1 }, edges: [...edges], changed: true }
    }

    case 'remove': {
      if (!layers.some((l) => l.id === edit.id)) return same
      const handles = new Set(layerHandleIds(edit.id))
      const rest: Record<string, unknown> = { ...params, layers: layers.filter((l) => l.id !== edit.id) }
      delete rest[opacityParamId(edit.id)]
      delete rest[maskParamId(edit.id)]
      // Its wires go with it, in the same edit: a wire left on a port that no
      // longer exists is unreadable, and one undo must restore both.
      return {
        params: rest,
        edges: edges.filter((e) => !(e.target === nodeId && handles.has(e.targetHandle ?? ''))),
        changed: true,
      }
    }

    case 'reorder': {
      const top = toTopFirst(layers)
      const { from, to } = edit
      if (from === to || from < 0 || to < 0 || from >= top.length || to >= top.length) return same
      const [moved] = top.splice(from, 1)
      top.splice(to, 0, moved)
      // Back to storage order with the same flip. Ports are keyed by id, so
      // every wire follows its layer.
      return { params: { ...params, layers: toTopFirst(top) }, edges: [...edges], changed: true }
    }

    case 'toggleVisible': {
      if (!layers.some((l) => l.id === edit.id)) return same
      // Wires stay: a hidden layer keeps its source, opacity and mask.
      return {
        params: { ...params, layers: layers.map((l) => (l.id === edit.id ? { ...l, visible: !l.visible } : l)) },
        edges: [...edges],
        changed: true,
      }
    }

    case 'blend': {
      const layer = layers.find((l) => l.id === edit.id)
      if (!layer || !isBlendMode(edit.blendMode) || layer.blendMode === edit.blendMode) return same
      return {
        params: { ...params, layers: layers.map((l) => (l.id === edit.id ? { ...l, blendMode: edit.blendMode } : l)) },
        edges: [...edges],
        changed: true,
      }
    }
  }
}
