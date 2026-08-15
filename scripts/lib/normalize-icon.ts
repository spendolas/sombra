import { parse, stringify, type INode } from 'svgson'
import svgpath from 'svgpath'
import type { IconNode } from '../../src/icons/create-icon'

const SCALE = 16 / 24

// Attributes whose numeric value must be multiplied by SCALE, per element tag.
const SCALE_ATTRS: Record<string, string[]> = {
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
}
const POINTS_TAGS = new Set(['polyline', 'polygon'])
// Attributes to drop from children — geometry only survives.
const DROP_ATTRS = new Set(['stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill', 'class'])

const round = (n: number) => Math.round(n * 1000) / 1000

function scalePoints(points: string): string {
  return points
    .trim()
    .split(/\s+/)
    .map((pair) =>
      pair
        .split(',')
        .map((v) => String(round(parseFloat(v) * SCALE)))
        .join(','),
    )
    .join(' ')
}

function scaleChild(el: INode): [string, Record<string, string | number>] {
  const attrs: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(el.attributes)) {
    if (DROP_ATTRS.has(k)) continue
    if (el.name === 'path' && k === 'd') {
      attrs.d = svgpath(v).scale(SCALE).round(3).toString()
    } else if (POINTS_TAGS.has(el.name) && k === 'points') {
      attrs.points = scalePoints(v)
    } else if (SCALE_ATTRS[el.name]?.includes(k)) {
      attrs[k] = round(parseFloat(v) * SCALE)
    } else {
      attrs[k] = v
    }
  }
  return [el.name, attrs]
}

export async function normalizeIcon(lucideSvg: string): Promise<{ svgText: string; node: IconNode }> {
  const root = await parse(lucideSvg)
  const children = root.children.filter((c) => c.type === 'element')
  const node: IconNode = children.map(scaleChild)

  // Serialise the owned SVG: root attrs fixed, children carry scaled geometry only.
  const ownedRoot: INode = {
    name: 'svg',
    type: 'element',
    value: '',
    attributes: {
      xmlns: 'http://www.w3.org/2000/svg',
      width: '16',
      height: '16',
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    children: node.map(([name, attrs]) => ({
      name,
      type: 'element',
      value: '',
      attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])),
      children: [],
    })),
  }
  return { svgText: stringify(ownedRoot), node }
}

// No scaling — extract child geometry from an already-owned 16-grid SVG.
export async function svgToNode(svgText: string): Promise<IconNode> {
  const root = await parse(svgText)
  return root.children
    .filter((c) => c.type === 'element')
    .map((el) => {
      const attrs: Record<string, string | number> = {}
      for (const [k, v] of Object.entries(el.attributes)) {
        if (DROP_ATTRS.has(k)) continue
        attrs[k] = v
      }
      return [el.name, attrs] as [string, Record<string, string | number>]
    })
}
