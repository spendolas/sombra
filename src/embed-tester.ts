/**
 * Embed Tester — paste an exported snippet, get a live preview + auto-discovered
 * knobs wired through the SceneHandle API. Doubles as a framework-agnostic
 * reference for how a host page consumes the toolkit (nodes() → controls → set()).
 *
 * It extracts the scene/hash from whatever you paste (Copy-paste, Developer, or
 * Advanced snippet) and drives it with the in-repo player — so it works locally
 * without the CDN bundle being deployed.
 */
import { mount, type SceneHandle } from './embed/player'
import type { NodeInfo, Knob } from './embed/artifact'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const input = $<HTMLTextAreaElement>('input')
const modeBadge = $<HTMLSpanElement>('mode')
const errorEl = $<HTMLDivElement>('error')
const preview = $<HTMLDivElement>('preview')
const knobsEl = $<HTMLDivElement>('knobs')
const knobCount = $<HTMLSpanElement>('knobcount')

let handle: SceneHandle | null = null

// --- helpers ---------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function setError(msg: string) { errorEl.textContent = msg }

const clamp01 = (c: number) => Math.max(0, Math.min(1, c))
const toHex = (rgb: number[]) =>
  '#' + rgb.slice(0, 3).map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0')).join('')
const fromHex = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

// --- snippet parsing -------------------------------------------------------

type Mode = 'developer' | 'copy-paste' | 'iframe' | 'none'
interface Parsed { mode: Mode; scene?: string; hash?: string }

function parse(text: string): Parsed {
  const scene = text.match(/(?:data-sombra-scene=|scene:\s*)["']([A-Za-z0-9_-]+)["']/)
  const frame = text.match(/viewer\.html#g=([A-Za-z0-9_-]+)/)
  if (scene) {
    const mode: Mode = /Sombra\.mount\s*\(/.test(text) ? 'developer'
      : /data-sombra-scene\s*=/.test(text) ? 'copy-paste' : 'developer'
    return { mode, scene: scene[1] }
  }
  if (frame) return { mode: 'iframe', hash: frame[1] }
  return { mode: 'none' }
}

const MODE_LABEL: Record<Mode, string> = {
  'developer': 'developer mode',
  'copy-paste': 'copy-paste mode',
  'iframe': 'iframe (advanced)',
  'none': 'no snippet',
}

// --- knob controls ---------------------------------------------------------

function knobRow(h: SceneHandle, node: NodeInfo, k: Knob): HTMLElement {
  const row = el('div', 'knob')
  const label = el('div', 'k-label')
  label.appendChild(el('span', undefined, k.label))
  label.appendChild(el('span', 'k-key', k.key))
  row.appendChild(label)

  const val = el('span', 'k-val')
  const apply = (v: number | number[]) => h.set(node.id, k.param, v)

  if (k.type === 'color') {
    const rgb = Array.isArray(k.value) ? k.value : [0, 0, 0]
    const picker = el('input') as HTMLInputElement
    picker.type = 'color'
    picker.value = toHex(rgb)
    val.textContent = picker.value
    picker.oninput = () => { const c = fromHex(picker.value); apply(c); val.textContent = picker.value }
    row.appendChild(picker)
    row.appendChild(val)
  } else if (k.type === 'vec2' || k.type === 'vec3') {
    const n = k.type === 'vec2' ? 2 : 3
    const cur = Array.isArray(k.value) ? [...k.value] : new Array(n).fill(0)
    const wrap = el('div', 'k-vec')
    for (let i = 0; i < n; i++) {
      const inp = el('input') as HTMLInputElement
      inp.type = 'number'; inp.step = String(k.step ?? 0.01); inp.value = String(cur[i] ?? 0)
      inp.oninput = () => { cur[i] = Number(inp.value); apply([...cur]); val.textContent = cur.map((x) => +x.toFixed(2)).join(', ') }
      wrap.appendChild(inp)
    }
    val.textContent = cur.map((x) => +Number(x).toFixed(2)).join(', ')
    row.appendChild(wrap)
    row.appendChild(val)
  } else {
    const min = k.min ?? 0, max = k.max ?? 1
    const step = k.step ?? ((max - min) / 100 || 0.01)
    const cur = typeof k.value === 'number' ? k.value : min
    const slider = el('input') as HTMLInputElement
    slider.type = 'range'; slider.min = String(min); slider.max = String(max); slider.step = String(step); slider.value = String(cur)
    val.textContent = String(+cur.toFixed(step < 1 ? 3 : 0))
    slider.oninput = () => { const v = Number(slider.value); apply(v); val.textContent = String(+v.toFixed(step < 1 ? 3 : 0)) }
    row.appendChild(slider)
    row.appendChild(val)
  }
  return row
}

function nodeGroup(h: SceneHandle, node: NodeInfo): HTMLElement {
  const g = el('div', 'node-group')
  const head = el('div', 'node-head')
  head.appendChild(el('span', 'name', node.name))
  const id = el('span', 'id', `id: ${node.id} ⧉`)
  id.title = 'Copy node id — for shader.set(id, param, value)'
  id.onclick = () => { void navigator.clipboard.writeText(node.id); id.textContent = 'id copied ✓'; setTimeout(() => { id.textContent = `id: ${node.id} ⧉` }, 1200) }
  head.appendChild(id)
  g.appendChild(head)
  for (const k of node.params) g.appendChild(knobRow(h, node, k))
  return g
}

function buildKnobs(h: SceneHandle) {
  const nodes = h.nodes()
  const total = nodes.reduce((n, grp) => n + grp.params.length, 0)
  knobCount.textContent = total ? `(${total})` : ''
  knobsEl.innerHTML = ''
  if (!total) { knobsEl.appendChild(el('div', 'note', 'This scene exposes no knobs.')); return }
  for (const node of nodes) knobsEl.appendChild(nodeGroup(h, node))
}

// --- run -------------------------------------------------------------------

async function run() {
  setError('')
  const p = parse(input.value)
  modeBadge.dataset.mode = p.mode
  modeBadge.textContent = MODE_LABEL[p.mode]

  handle?.destroy()
  handle = null
  preview.innerHTML = ''
  knobsEl.innerHTML = ''
  knobCount.textContent = ''

  if (p.mode === 'iframe') {
    const frame = el('iframe') as HTMLIFrameElement
    frame.src = `${location.origin}/sombra/viewer.html#g=${p.hash}`
    frame.allow = 'fullscreen'
    preview.appendChild(frame)
    knobsEl.appendChild(el('div', 'note', 'Advanced / iframe mode is fully sandboxed — it exposes no knob API. Preview only.'))
    return
  }
  if (p.mode === 'none' || !p.scene) {
    setError('No scene found in the pasted code. Paste a Copy-paste, Developer, or Advanced snippet from the Embed modal.')
    knobsEl.appendChild(el('div', 'note', '—'))
    return
  }

  handle = await mount(preview, {
    scene: p.scene,
    onError: (e) => setError(`Mount failed: ${e.message}`),
    onLoad: buildKnobs,
  })
  ;(window as unknown as { __testerHandle: SceneHandle | null }).__testerHandle = handle
}

// --- sample (compiles the default graph so there's always something to test) ---

async function loadSample() {
  setError('Building a sample…')
  try {
    const [{ initializeNodeLibrary }, { createDefaultGraph }, { publishScene }] = await Promise.all([
      import('./nodes'), import('./utils/test-graph'), import('./embed/publish'),
    ])
    initializeNodeLibrary()
    const { nodes, edges } = createDefaultGraph()
    const { snippets } = publishScene(nodes, edges)
    input.value = snippets.developer
    setError('')
    await run()
  } catch (e) {
    setError(`Could not build sample: ${e instanceof Error ? e.message : String(e)}`)
  }
}

$<HTMLButtonElement>('run').onclick = () => { void run() }
$<HTMLButtonElement>('clear').onclick = () => {
  input.value = ''; handle?.destroy(); handle = null
  preview.innerHTML = ''; knobsEl.innerHTML = ''; knobCount.textContent = ''
  modeBadge.dataset.mode = 'none'; modeBadge.textContent = MODE_LABEL.none; setError('')
}
$<HTMLButtonElement>('sample').onclick = () => { void loadSample() }
input.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run() } })
