/**
 * Embed Tester — a realistic third-party host sandbox.
 *
 * The pasted snippet runs inside a same-origin `srcdoc` iframe: a FRESH document
 * with NOTHING Sombra-related pre-linked, that loads the real built UMD player
 * via its own <script> tag (exactly like a customer's page loading our CDN).
 * The "Host page" selector simulates the two extremes the user asked about — a
 * bare zero-JS page and a heavy page that already ships libs we use / many GPU
 * contexts — and verifies we neither clobber nor get clobbered.
 *
 * The knob panel (in the parent) reaches the iframe's SceneHandle via the
 * cross-frame handle registry (Sombra.get) and drives it live.
 *
 * Local note: the snippet's CDN URL is rewritten to this origin; a Vite dev
 * middleware serves the built bundle from dist/embed. Run `npm run build:embed`
 * first — the tester says so if the bundle is missing.
 */
import type { SceneHandle } from './embed/player'
import type { NodeInfo, Knob } from './embed/artifact'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const input = $<HTMLTextAreaElement>('input')
const envSel = $<HTMLSelectElement>('env')
const modeBadge = $<HTMLSpanElement>('mode')
const errorEl = $<HTMLDivElement>('error')
const envStatusEl = $<HTMLDivElement>('envstatus')
const preview = $<HTMLDivElement>('preview')
const knobsEl = $<HTMLDivElement>('knobs')
const knobCount = $<HTMLSpanElement>('knobcount')

const CDN_BASE = 'https://spendolas.github.io/sombra'

type WinWithSombra = Window & {
  Sombra?: { get?: (t: string) => SceneHandle | undefined }
  pako?: { SENTINEL?: string }
}

// --- helpers ---------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
function setError(msg: string) { errorEl.textContent = msg }
function setEnvStatus(html: string) { envStatusEl.innerHTML = html }

const clamp01 = (c: number) => Math.max(0, Math.min(1, c))
const toHex = (rgb: number[]) => '#' + rgb.slice(0, 3).map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0')).join('')
const fromHex = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

// --- snippet parsing -------------------------------------------------------

type Mode = 'embed' | 'iframe' | 'none'
function parse(text: string): Mode {
  if (
    /data-sombra-scene\s*=/.test(text) ||
    /data-sombra-src\s*=/.test(text) ||
    /data-sombra-id\s*=/.test(text) ||
    /Sombra\.mount\s*\(/.test(text)
  ) return 'embed'
  if (/viewer\.html#g=/.test(text)) return 'iframe'
  return 'none'
}
const MODE_LABEL: Record<Mode, string> = { embed: 'embed', iframe: 'iframe (isolated)', none: 'no snippet' }

// Point the CDN URLs at this origin so the built bundle / viewer load locally.
const rewrite = (text: string) => text.split(CDN_BASE).join(`${location.origin}/sombra`)

// --- host-environment presets (injected into the iframe BEFORE the snippet) ---

function envPreset(env: string): string {
  if (env === 'conflict') {
    return `<script>
      // Host already uses pako and some globals — our bundled copy must not touch them.
      window.pako = { SENTINEL: 'host-pako-v1' };
      window.$ = function () { return 'host-jquery'; };
      window.__hostGlobal = 'do-not-touch';
    </script>`
  }
  if (env === 'heavy') {
    return `<script>
      // Heavy host: several live WebGL contexts + a busy main-thread loop.
      for (var i = 0; i < 6; i++) {
        var c = document.createElement('canvas'); c.width = c.height = 192;
        c.style.cssText = 'position:absolute;left:-9999px;top:0';
        document.documentElement.appendChild(c); c.getContext('webgl');
      }
      (function spin(){ var t = performance.now(); while (performance.now() - t < 3) {} requestAnimationFrame(spin); })();
    </script>`
  }
  return ''
}

function buildSrcdoc(snippet: string, env: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}[data-sombra-scene],#sombra-shader{width:100%!important;height:100%!important;aspect-ratio:auto!important}iframe{width:100%;height:100%;border:0}</style>
${envPreset(env)}
</head><body>${snippet}</body></html>`
}

// --- knob controls (drive the iframe's handle cross-frame) -----------------

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
    picker.type = 'color'; picker.value = toHex(rgb); val.textContent = picker.value
    picker.oninput = () => { apply(fromHex(picker.value)); val.textContent = picker.value }
    row.append(picker, val)
  } else if (k.type === 'vec2' || k.type === 'vec3') {
    const n = k.type === 'vec2' ? 2 : 3
    const cur = Array.isArray(k.value) ? [...k.value] : new Array(n).fill(0)
    const wrap = el('div', 'k-vec')
    for (let i = 0; i < n; i++) {
      const inp = el('input') as HTMLInputElement
      inp.type = 'number'; inp.step = String(k.step ?? 0.01); inp.value = String(cur[i] ?? 0)
      inp.oninput = () => { cur[i] = Number(inp.value); apply([...cur]); val.textContent = cur.map((x) => +Number(x).toFixed(2)).join(', ') }
      wrap.appendChild(inp)
    }
    val.textContent = cur.map((x) => +Number(x).toFixed(2)).join(', ')
    row.append(wrap, val)
  } else {
    // Custom pointer-driven slider (NOT a native <input type=range>). Native range
    // depends on focus + implicit pointer capture; some pens/styluses fail to grant
    // it, so the drag aborts mid-press (focus falls to <body>, zero value change).
    // This slider drives value from clientX under explicit pointer capture and never
    // relies on focus, so it survives pen/touch/mouse identically.
    const min = k.min ?? 0, max = k.max ?? 1, step = k.step ?? ((max - min) / 100 || 0.01)
    let cur = typeof k.value === 'number' ? k.value : min
    const fmt = (v: number) => String(+v.toFixed(step < 1 ? 3 : 0))

    const track = el('div', 'c-slider')
    const fill = el('div', 'c-slider-fill')
    const thumb = el('div', 'c-slider-thumb')
    track.append(fill, thumb)

    const render = (v: number) => {
      const pct = max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) * 100 : 0
      fill.style.width = `${pct}%`
      thumb.style.left = `${pct}%`
      val.textContent = fmt(v)
    }
    const valueFromX = (clientX: number) => {
      const rect = track.getBoundingClientRect()
      const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
      const raw = min + Math.max(0, Math.min(1, frac)) * (max - min)
      return Math.max(min, Math.min(max, Math.round(raw / step) * step))
    }
    const applyAt = (clientX: number) => {
      const v = valueFromX(clientX)
      render(v)
      if (v !== cur) { cur = v; apply(v) }
    }

    track.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      try { track.setPointerCapture(e.pointerId) } catch { /* pointer already released */ }
      applyAt(e.clientX)
      // Track on window so the drag survives even if capture is lost (button held).
      const onMove = (ev: PointerEvent) => applyAt(ev.clientX)
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    })

    render(cur)
    row.append(track, val)
  }
  return row
}

function nodeGroup(h: SceneHandle, node: NodeInfo): HTMLElement {
  const g = el('div', 'node-group')
  const head = el('div', 'node-head')
  head.appendChild(el('span', 'name', node.name))
  const id = el('span', 'id', `id: ${node.id} ⧉`)
  id.title = 'Copy node id'
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

async function onFrameLoad(frame: HTMLIFrameElement, mode: Mode, env: string) {
  const win = frame.contentWindow as unknown as WinWithSombra
  if (mode === 'iframe') {
    knobsEl.appendChild(el('div', 'note', 'iframe / advanced mode — a sandboxed viewer with no knob API.'))
    return
  }

  // Wait for the real bundle to load + auto-mount inside the frame.
  let handle: SceneHandle | undefined
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    const S = win.Sombra
    if (S && typeof S.get === 'function') { handle = S.get('sombra-shader'); if (handle) break }
    await new Promise((r) => setTimeout(r, 150))
  }

  // Conflict verdict — did our bundle touch the host's globals?
  if (env === 'conflict') {
    const pakoIntact = win.pako?.SENTINEL === 'host-pako-v1'
    const mounted = !!handle
    const cls = (ok: boolean) => (ok ? 'ok' : 'bad')
    setEnvStatus(
      `Conflict check — host <code>pako</code>: <span class="${cls(pakoIntact)}">${pakoIntact ? 'intact ✓' : 'CLOBBERED ✗'}</span> · ` +
      `<code>__hostGlobal</code>: <span class="${cls((win as unknown as { __hostGlobal?: string }).__hostGlobal === 'do-not-touch')}">${(win as unknown as { __hostGlobal?: string }).__hostGlobal === 'do-not-touch' ? 'intact ✓' : 'CLOBBERED ✗'}</span> · ` +
      `player mounted: <span class="${cls(mounted)}">${mounted ? 'yes ✓' : 'no ✗'}</span>`,
    )
  } else if (env === 'heavy') {
    setEnvStatus(`Heavy host: 6 live WebGL contexts + busy loop. Player mounted: <span class="${handle ? 'ok' : 'bad'}">${handle ? 'yes ✓' : 'no ✗'}</span>`)
  }

  if (!handle) {
    setError('Player did not mount inside the host frame. Locally, build the bundle first: npm run build:embed (the tester serves it from dist/embed).')
    return
  }
  buildKnobs(handle)
}

function run() {
  setError(''); setEnvStatus('')
  knobsEl.innerHTML = ''; knobCount.textContent = ''; preview.innerHTML = ''
  const mode = parse(input.value)
  modeBadge.dataset.mode = mode; modeBadge.textContent = MODE_LABEL[mode]
  if (mode === 'none') { setError('No snippet detected. Paste an Embed or iframe snippet from the Embed modal, or click "Load a sample".'); return }

  const env = envSel.value
  const frame = document.createElement('iframe')
  frame.setAttribute('title', 'host page')
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  frame.addEventListener('load', () => { void onFrameLoad(frame, mode, env) })
  frame.srcdoc = buildSrcdoc(rewrite(input.value), env)
  preview.appendChild(frame)
}

async function loadSample() {
  setError('Building a sample…')
  try {
    const [{ initializeNodeLibrary }, { createDefaultGraph }, { publishScene }] = await Promise.all([
      import('./nodes'), import('./utils/test-graph'), import('./embed/publish'),
    ])
    initializeNodeLibrary()
    const { nodes, edges } = createDefaultGraph()
    input.value = publishScene(nodes, edges).snippets.embed
    setError('')
    run()
  } catch (e) {
    setError(`Could not build sample: ${e instanceof Error ? e.message : String(e)}`)
  }
}

$<HTMLButtonElement>('run').onclick = run
$<HTMLButtonElement>('sample').onclick = () => { void loadSample() }
$<HTMLButtonElement>('clear').onclick = () => {
  input.value = ''; preview.innerHTML = ''; knobsEl.innerHTML = ''; knobCount.textContent = ''
  setError(''); setEnvStatus(''); modeBadge.dataset.mode = 'none'; modeBadge.textContent = MODE_LABEL.none
}
input.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run() } })

// Keep a slider drag alive when the cursor passes over the preview iframe —
// iframes swallow pointer events and would otherwise abort the drag.
const setPreviewInert = (inert: boolean) => {
  const f = preview.querySelector('iframe')
  if (f) f.style.pointerEvents = inert ? 'none' : ''
}
knobsEl.addEventListener('pointerdown', () => setPreviewInert(true))
window.addEventListener('pointerup', () => setPreviewInert(false))
window.addEventListener('pointercancel', () => setPreviewInert(false))
