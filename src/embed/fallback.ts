/**
 * DVD-screensaver fallback — the bouncing "SOMBRA" placeholder the editor shows
 * when no valid shader is compiled (src/components/ShaderPlaceholder.tsx),
 * reimplemented framework-free so the embed player can show it on error without
 * pulling React into the bundle. Returns a stop() that cancels the loop and
 * removes the overlay.
 */
export function showFallback(el: HTMLElement, message?: string): () => void {
  const box = document.createElement('div')
  box.setAttribute('data-sombra-fallback', '')
  Object.assign(box.style, {
    position: 'relative', width: '100%', height: '100%', minHeight: '140px',
    overflow: 'hidden', background: '#000', display: 'block',
  } satisfies Partial<CSSStyleDeclaration>)

  const text = document.createElement('div')
  text.textContent = 'SOMBRA'
  Object.assign(text.style, {
    position: 'absolute', top: '0', left: '0',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSize: '1.5rem', fontWeight: '500', letterSpacing: '0.35em',
    whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  box.appendChild(text)

  if (message) {
    const err = document.createElement('div')
    err.textContent = `[Sombra] ${message}`
    Object.assign(err.style, {
      position: 'absolute', left: '8px', right: '8px', bottom: '6px',
      font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
      color: 'rgba(248,113,113,0.85)', whiteSpace: 'pre-wrap', pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>)
    box.appendChild(err)
  }

  el.appendChild(box)

  let x = Math.random() * 200, y = Math.random() * 100, vx = 2, vy = 1.5
  let hue = Math.random() * 360
  text.style.color = `hsl(${hue} 60% 55% / 0.35)`

  let raf = 0
  const tick = () => {
    const cw = box.clientWidth, ch = box.clientHeight
    const tw = text.offsetWidth, th = text.offsetHeight
    x += vx; y += vy
    let bounced = false
    if (x <= 0) { x = 0; vx = Math.abs(vx); bounced = true }
    if (x >= cw - tw) { x = cw - tw; vx = -Math.abs(vx); bounced = true }
    if (y <= 0) { y = 0; vy = Math.abs(vy); bounced = true }
    if (y >= ch - th) { y = ch - th; vy = -Math.abs(vy); bounced = true }
    if (bounced) {
      hue = (hue + 55 + Math.random() * 30) % 360
      text.style.color = `hsl(${hue} 60% 55% / 0.35)`
    }
    text.style.transform = `translate(${x}px, ${y}px)`
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => { cancelAnimationFrame(raf); box.remove() }
}
