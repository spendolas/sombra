/**
 * measure-spectra-worley-baseline — NOT a gate: the measurement behind the
 * `SPECTRA` constants in verify-embed-site-worley-gpu.ts. Renders spectra's own
 * pixel-mode fragment shader (the www repo's src/spectraGL-noisekit.js) with
 * the Preset 3 "Worley Ridged" uniforms (spec S-B-LOOK-SPEC §1) on raw WebGL in
 * headless Chrome, 1440×900, DPR 1, t = 30 s and 90 s, and computes the same
 * per-cell metrics the GPU gate computes on the Sombra scene.
 *
 *   npx tsx scripts/measure-spectra-worley-baseline.ts <www>/src/spectraGL-noisekit.js [seeds=40] [dotPx=4]
 *
 * dotPx 4 matches the Sombra grid (4/32 device px); 3.5 is spectra's real P3.
 * Seeds are spectra's own space ([0,200)², 2 dp) from a fixed LCG.
 */
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const kit = readFileSync(process.argv[2], 'utf8')
// The pixel material's fragment: the JSON string literal after `pixel: {` … `fragment:`.
const at = kit.indexOf('fragment:', kit.indexOf('pixel: {'))
const q = kit.indexOf('"', at)
let e = q + 1
while (kit[e] !== '"') e += kit[e] === '\\' ? 2 : 1
const frag = JSON.parse(kit.slice(q, e + 1)) as string
const N = Number(process.argv[3] ?? 40)
const PS = Number(process.argv[4] ?? 4)          // dot px (spectra P3 = 3.5; 4 = grid-comparable)
const W = 1440, H = 900
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage()
await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' }); await page.goto('about:blank')
const res = await page.evaluate(([fs, n, ps, w, h]) => {
  const c = document.createElement('canvas'); c.width = w as number; c.height = h as number
  const gl = c.getContext('webgl', { preserveDrawingBuffer: true, antialias: false })! as unknown as WebGL2RenderingContext; gl.getExtension('OES_standard_derivatives')
  const vs = `precision highp float; attribute vec2 position; varying vec2 vUv; varying vec3 vNormal; varying vec3 vPosition; varying float vDisplacement;
    void main(){ vUv = position*0.5+0.5; vNormal=vec3(0.); vPosition=vec3(0.); vDisplacement=0.; gl_Position=vec4(position,0.,1.); }`
  const mk = (t: number, s: string) => { const sh = gl.createShader(t)!; gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)!); return sh }
  const pr = gl.createProgram()!
  gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs))
  gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, '#extension GL_OES_standard_derivatives : enable\nprecision highp float;\nprecision highp int;\n' + (fs as string)))
  gl.bindAttribLocation(pr, 0, 'position'); gl.linkProgram(pr)
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr)!)
  gl.useProgram(pr)
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  const U = (name: string) => gl.getUniformLocation(pr, name)
  const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255)
  const stops = ['#160709', '#ff4f5e', '#3ddc97', '#4d9fff']
  const cols = [...stops, '#000000', '#000000', '#000000'].flatMap(hex)
  gl.uniform3fv(U('uColors'), cols); gl.uniform1fv(U('uColorBalance'), new Array(7).fill(1)); gl.uniform1fv(U('uColorOpacity'), new Array(7).fill(1))
  gl.uniform1f(U('uColorBlend'), 0); gl.uniform1f(U('uDirection'), 1); gl.uniform1f(U('uSpeed'), 1e-5)
  gl.uniform1f(U('uFoldIntensity'), ((ps as number) - 3) / 5); gl.uniform1f(U('uFoldScale'), 0.1); gl.uniform1f(U('uFoldSpeed'), 5)
  gl.uniform1i(U('uFieldOctaves'), 1); gl.uniform1f(U('uFieldLacunarity'), 2); gl.uniform1f(U('uFieldGain'), 0); gl.uniform1f(U('uFieldAmplitude'), 1)
  gl.uniform1f(U('uFieldWarpStrength'), 0.2); gl.uniform2f(U('uFieldFlow'), 0.02, -0.01); gl.uniform1f(U('uFieldAngle'), 0)
  gl.uniform1i(U('uFieldNoiseType'), 2); gl.uniform1i(U('uFieldFractalType'), 3); gl.uniform1f(U('uFieldBoxFreq'), 6); gl.uniform1i(U('uFieldDebug'), 0)
  gl.uniform1f(U('uFieldMin'), 0.2); gl.uniform1f(U('uFieldMax'), 0.8); gl.uniform1f(U('uFieldDensity'), 0)
  gl.uniform1f(U('uRimFalloff'), 0.5); gl.uniform1f(U('uRimLight'), 0); gl.uniform1f(U('uRimIntensity'), 0); gl.uniform1f(U('uGrain'), 0)
  gl.uniform1f(U('uReactiveStrength'), 0); gl.uniform1f(U('uMouseRadius'), 0.2); gl.uniform2f(U('uMouse'), -10, -10); gl.uniform1f(U('uPulse'), 0)
  gl.uniform2f(U('uResolution'), w as number, h as number); gl.uniform1f(U('uUseTextMask'), 0); gl.uniform1f(U('uScrollOffset'), 0)
  gl.uniform2f(U('uDisplacement'), 0, 0)
  const px = new Uint8Array((w as number) * (h as number) * 4)
  const draw = (time: number, seed: number[], bal = 0) => {
    gl.uniform1f(U('uTime'), time); gl.uniform2f(U('uFieldSeed'), seed[0], seed[1]); gl.uniform1f(U('uFieldDensity'), bal)
    gl.viewport(0, 0, w as number, h as number); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.readPixels(0, 0, w as number, h as number, gl.RGBA, gl.UNSIGNED_BYTE, px); return px
  }
  const c0 = hex(stops[0]).map((v) => Math.round(v * 255))
  const cell = (ps as number) * 8, dot = ps as number
  const metrics = (p: Uint8Array) => {
    const ww = w as number, hh = h as number
    const isOff = (i: number) => p[i] === c0[0] && p[i + 1] === c0[1] && p[i + 2] === c0[2]
    const nx = Math.floor(ww / cell), ny = Math.floor(hh / cell)
    const levels: number[] = []; let on = 0
    for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) {
      let k = 0
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
        const x = Math.floor(cx * cell + i * dot + dot / 2), y = Math.floor(cy * cell + j * dot + dot / 2)
        if (!isOff((y * ww + x) * 4)) k++
      }
      levels.push(k / 64); on += k
    }
    const run = (len: number, count: number, idx: (k: number, i: number) => number) => {
      let runs = 0, cells = 0
      for (let k = 0; k < count; k++) { runs++; cells++; for (let i = 1; i < len; i++) { if (Math.abs(levels[idx(k, i)] - levels[idx(k, i - 1)]) > 0.08) runs++; cells++ } }
      return cells / runs
    }
    const rr = run(nx, ny, (k, i) => k * nx + i), rc = run(ny, nx, (k, i) => i * nx + k)
    return { coverage: on / (levels.length * 64), extreme: levels.filter((l) => l < 0.02 || l > 0.98).length / levels.length, rr, rc, aniso: Math.max(rr, rc) / Math.min(rr, rc), levels }
  }
  const out = []
  let s = 12345
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  for (let k = 0; k < (n as number); k++) {
    const seed = [Math.round(rnd() * 20000) / 100, Math.round(rnd() * 20000) / 100]
    const a = metrics(draw(30, seed)); const b = metrics(draw(90, seed))
    let ch = 0; for (let i = 0; i < a.levels.length; i++) if (a.levels[i] !== b.levels[i]) ch++
    out.push({ seed, coverage: a.coverage, extreme: a.extreme, rr: a.rr, rc: a.rc, aniso: a.aniso, temporal: ch / a.levels.length })
  }
  return out
}, [frag, N, PS, W, H] as const)
const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
for (const r of res) console.log(`${r.seed.join(',').padEnd(14)} cov ${r.coverage.toFixed(3)} ext ${r.extreme.toFixed(3)} rr ${r.rr.toFixed(2)} rc ${r.rc.toFixed(2)} aniso ${r.aniso.toFixed(2)} dt60 ${r.temporal.toFixed(3)}`)
const pick = (k: 'coverage' | 'extreme' | 'temporal' | 'aniso') => res.map((r) => r[k])
console.log(`N=${res.length} ps=${PS}: median cov ${med(pick('coverage')).toFixed(3)} [${Math.min(...pick('coverage')).toFixed(2)}..${Math.max(...pick('coverage')).toFixed(2)}]  median ext ${med(pick('extreme')).toFixed(3)} [${Math.min(...pick('extreme')).toFixed(2)}..${Math.max(...pick('extreme')).toFixed(2)}]  aniso>1.5 ${res.filter((r) => r.aniso > 1.5).length}/${res.length}  median dt60 ${med(pick('temporal')).toFixed(3)}`)
await browser.close()
