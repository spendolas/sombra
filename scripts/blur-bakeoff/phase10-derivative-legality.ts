/**
 * Phase 10b — derivative legality audit, measured against real compilers.
 *
 * Question: where may `fwidth` / `dpdx` / `dpdy` (WGSL) and `fwidth` / `dFdx` /
 * `dFdy` (GLSL ES 3.00) legally appear in the Reeded Glass shader, given that
 * `frost` is connectable and its `if` may therefore be non-uniform?
 *
 * The answer is decided by Tint (Chrome/Dawn) and by the WebGL2 GLSL compiler,
 * not by reading the spec, so every case below is compiled for real. The base
 * shader is the node's ACTUAL emitted pass, dumped by phase10-emit-dump.ts —
 * no reimplementation.
 *
 * CALIBRATION: every gate is exercised by a known-good AND a known-bad control.
 * If a known-bad control fails to produce an error, the whole run is reported
 * as UNCALIBRATED and no "legal" verdict from it may be trusted.
 *
 * Prereq: npx tsx scripts/blur-bakeoff/phase10-emit-dump.ts
 * Run:    npx tsx scripts/blur-bakeoff/phase10-derivative-legality.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright-core'
import { lowerStmtToWGSL } from '../../src/compiler/ir/wgsl-backend'
import { raw } from '../../src/compiler/ir/types'

const DUMP_DIR = path.join('reports', 'blur-bakeoff', 'phase10')
const OUT_JSON = path.join(DUMP_DIR, 'derivative-legality.json')

type Expect = 'legal' | 'illegal'

interface Case {
  id: string
  what: string
  expect: Expect
  /** 'control' cases calibrate the gate; a wrong verdict invalidates the run. */
  control?: boolean
  src: string
}

// ---------------------------------------------------------------------------
// Source construction — textual surgery on the REAL emitted shaders
// ---------------------------------------------------------------------------

function read(f: string): string {
  return fs.readFileSync(path.join(DUMP_DIR, f), 'utf8')
}

/** Insert `code` immediately before the given anchor line (first match). */
function insertBefore(src: string, anchor: string, code: string): string {
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`anchor not found: ${anchor}`)
  return src.slice(0, i) + code + '\n' + src.slice(i)
}

/** Insert `code` immediately after the given anchor line (first match). */
function insertAfterLine(src: string, anchor: string, code: string): string {
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`anchor not found: ${anchor}`)
  const eol = src.indexOf('\n', i)
  return src.slice(0, eol + 1) + code + '\n' + src.slice(eol + 1)
}

function replaceOnce(src: string, from: string, to: string): string {
  const i = src.indexOf(from)
  if (i < 0) throw new Error(`text not found: ${from}`)
  return src.slice(0, i) + to + src.slice(i + from.length)
}

/** Make the sink real so nothing is dead-code-eliminated before analysis. */
const WGSL_SINK = (v: string) => `  fo_probe = fo_probe + ${v};`
const WGSL_SINK_DECL = `  var fo_probe: f32 = 0.0;`

function wgslCases(): Case[] {
  const wired = read('wired-frost.wgsl.pass1.wgsl')
  const unif = read('uniform-frost.wgsl.pass1.wgsl')

  // Anchors in the emitted text.
  const A_ENTRY = '@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {'
  const A_SAMPLEUV = '  let rg_sampleUV_rg = in.position.xy / uniforms.u_viewport'
  const A_IF = '  if (rg_frost_rg > 0.001) {'
  const A_LOOPBODY = '      let rg_jit_rg = reedHash('
  const A_AFTER_IF = '  var fo_col_out: vec4f = node_rg_color;'
  const A_ELSE = '  } else {'
  const A_TEXSAMPLE_LOOP =
    '      let rg_s_rg = textureSampleLevel(u_pass0_tex_tex, u_pass0_tex_samp, rg_tap_rg, 0.0);'

  /** Add the probe accumulator + fold it into the returned alpha so it is live. */
  function live(src: string): string {
    let s = insertAfterLine(src, A_ENTRY, WGSL_SINK_DECL)
    s = replaceOnce(
      s,
      '  return vec4f(fo_col_out.rgb * fo_a_out, fo_a_out);',
      '  return vec4f(fo_col_out.rgb * fo_a_out, fo_a_out + fo_probe * 1e-30);',
    )
    return s
  }

  const cases: Case[] = []

  // --- controls -----------------------------------------------------------
  cases.push({
    id: 'W-ctl-good-wired',
    what: 'real emitted pass, frost WIRED (non-uniform), unmodified',
    expect: 'legal', control: true,
    src: wired,
  })
  cases.push({
    id: 'W-ctl-good-uniform',
    what: 'real emitted pass, frost as UNIFORM param, unmodified',
    expect: 'legal', control: true,
    src: unif,
  })
  cases.push({
    id: 'W-ctl-bad-uniformity',
    what: 'textureSample (implicit LOD) inside the non-uniform frost loop — the historical bug',
    expect: 'illegal', control: true,
    src: replaceOnce(
      wired, A_TEXSAMPLE_LOOP,
      '      let rg_s_rg = textureSample(u_pass0_tex_tex, u_pass0_tex_samp, rg_tap_rg);',
    ),
  })
  cases.push({
    id: 'W-ctl-bad-glslname',
    what: 'GLSL spelling dFdx() left in WGSL (what the mechanical translator would emit)',
    expect: 'illegal', control: true,
    src: live(insertBefore(wired, A_IF, WGSL_SINK('dFdx(rg_srt_scr_rg.x)'))),
  })

  // --- derivatives at top-of-function / before the branch -----------------
  cases.push({
    id: 'W-fwidth-top-continuous',
    what: 'fwidth(in.v_uv.x) at top of fs_main (continuous quantity)',
    expect: 'legal',
    src: live(insertAfterLine(wired, A_ENTRY, WGSL_SINK('fwidth(in.v_uv.x)'))),
  })
  cases.push({
    id: 'W-fwidth-presampleuv-folded',
    what: 'fwidth(rg_lens_scr_rg.x) just before the frost branch (DISCONTINUOUS quantity)',
    expect: 'legal',
    src: live(insertBefore(wired, A_IF, WGSL_SINK('fwidth(rg_lens_scr_rg.x)'))),
  })
  cases.push({
    id: 'W-dpdxdpdy-presampleuv',
    what: 'dpdx/dpdy of the sample UV just before the frost branch',
    expect: 'legal',
    src: live(insertBefore(wired, A_IF, WGSL_SINK('dpdx(rg_sampleUV_rg.x) + dpdy(rg_sampleUV_rg.y)'))),
  })
  cases.push({
    id: 'W-fine-coarse',
    what: 'dpdxFine / dpdxCoarse / fwidthFine before the branch',
    expect: 'legal',
    src: live(insertBefore(wired, A_IF,
      WGSL_SINK('dpdxFine(rg_sampleUV_rg.x) + dpdxCoarse(rg_sampleUV_rg.x) + fwidthFine(rg_sampleUV_rg.y)'))),
  })

  // --- derivatives inside the non-uniform branch --------------------------
  cases.push({
    id: 'W-fwidth-in-branch',
    what: 'fwidth inside the frost if-block (non-uniform condition)',
    expect: 'illegal',
    src: live(insertAfterLine(wired, A_IF, '  ' + WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })
  cases.push({
    id: 'W-fwidth-in-loop',
    what: 'fwidth inside the frost for-loop',
    expect: 'illegal',
    src: live(insertBefore(wired, A_TEXSAMPLE_LOOP, '    ' + WGSL_SINK('fwidth(rg_tap_rg.x)'))),
  })
  cases.push({
    id: 'W-fwidth-in-else',
    what: 'fwidth inside the else-arm of the frost branch',
    expect: 'illegal',
    src: live(insertAfterLine(wired, A_ELSE, '  ' + WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })

  // --- reconvergence ------------------------------------------------------
  cases.push({
    id: 'W-fwidth-after-branch',
    what: 'fwidth AFTER the frost if/else closes — does Tint model reconvergence?',
    expect: 'legal',
    src: live(insertBefore(wired, A_AFTER_IF, WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })

  // --- uniform-condition branch ------------------------------------------
  const A_IF_U = '  if (rg_frost_rg > 0.001) {'
  cases.push({
    id: 'W-fwidth-in-uniform-branch',
    what: 'fwidth inside the frost branch when frost is a UNIFORM (condition is uniform)',
    expect: 'legal',
    src: live(insertAfterLine(unif, A_IF_U, '  ' + WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })
  cases.push({
    id: 'W-texsample-in-uniform-branch',
    what: 'plain textureSample inside the frost branch when frost is a UNIFORM',
    expect: 'legal',
    src: replaceOnce(
      unif,
      '      let rg_s_rg = textureSampleLevel(u_pass0_tex_tex, u_pass0_tex_samp, rg_tap_rg, 0.0);',
      '      let rg_s_rg = textureSample(u_pass0_tex_tex, u_pass0_tex_samp, rg_tap_rg);',
    ),
  })

  // --- uniform loops (the supersample-loop shape a fix would want) --------
  cases.push({
    id: 'W-fwidth-in-uniform-loop',
    what: 'fwidth inside a top-level fixed-count for loop (uniform trip count)',
    expect: 'legal',
    src: live(insertBefore(wired, A_IF,
      `  for (var k: i32 = 0; k < 4; k++) {\n` +
      `  ${WGSL_SINK('fwidth(rg_sampleUV_rg.x)')}\n` +
      `  }`)),
  })
  cases.push({
    id: 'W-fwidth-in-loop-nonuniform-break',
    what: 'fwidth inside a top-level loop with a NON-UNIFORM early break',
    expect: 'illegal',
    src: live(insertBefore(wired, A_IF,
      `  for (var k: i32 = 0; k < 4; k++) {\n` +
      `    if (rg_frost_rg > f32(k)) { break; }\n` +
      `  ${WGSL_SINK('fwidth(rg_sampleUV_rg.x)')}\n` +
      `  }`)),
  })

  // --- derivative inside a helper function --------------------------------
  const helper = `fn fo_dwidth(v: f32) -> f32 { return fwidth(v); }\n\n`
  cases.push({
    id: 'W-fwidth-helper-from-uniform',
    what: 'fwidth inside a helper fn, called from uniform control flow',
    expect: 'legal',
    src: live(insertBefore(
      insertBefore(wired, '@fragment fn fs_main', helper),
      A_IF, WGSL_SINK('fo_dwidth(rg_sampleUV_rg.x)'))),
  })
  cases.push({
    id: 'W-fwidth-helper-from-branch',
    what: 'fwidth inside a helper fn, called from inside the non-uniform frost branch',
    expect: 'illegal',
    src: live(insertAfterLine(
      insertBefore(wired, '@fragment fn fs_main', helper),
      A_IF, '  ' + WGSL_SINK('fo_dwidth(rg_sampleUV_rg.x)'))),
  })

  // --- reconvergence is conditional on the block's behaviour being {Next} --
  cases.push({
    id: 'W-after-branch-with-return',
    what: 'fwidth after the frost if/else, when the if-arm contains an early `return`',
    expect: 'illegal',
    src: live(insertBefore(
      insertAfterLine(wired, A_IF, '    if (rg_frost_rg > 0.9) { return vec4f(0.0); }'),
      A_AFTER_IF, WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })
  cases.push({
    // MEASURED: legal. `discard` does not terminate the invocation in WGSL's
    // behaviour analysis — its behaviour set is {Next} — so the if still
    // reconverges. Only `return`/`break`/`continue` defeat reconvergence.
    id: 'W-after-branch-with-discard',
    what: 'fwidth after the frost if/else, when the if-arm contains a `discard`',
    expect: 'legal',
    src: live(insertBefore(
      insertAfterLine(wired, A_IF, '    if (rg_frost_rg > 0.9) { discard; }'),
      A_AFTER_IF, WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })

  // --- the diagnostic escape hatch ----------------------------------------
  cases.push({
    id: 'W-diagnostic-off-module',
    what: 'module-scope `diagnostic(off, derivative_uniformity);` + fwidth inside the frost branch',
    expect: 'legal',
    src: 'diagnostic(off, derivative_uniformity);\n' +
      live(insertAfterLine(wired, A_IF, '  ' + WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })
  cases.push({
    id: 'W-diagnostic-off-attr',
    what: '@diagnostic(off, derivative_uniformity) attribute on the frost if-statement',
    expect: 'legal',
    src: live(insertAfterLine(
      replaceOnce(wired, A_IF, '  @diagnostic(off, derivative_uniformity) if (rg_frost_rg > 0.001) {'),
      '  @diagnostic(off, derivative_uniformity) if (rg_frost_rg > 0.001) {',
      '  ' + WGSL_SINK('fwidth(rg_sampleUV_rg.x)'))),
  })
  cases.push({
    id: 'W-diagnostic-off-texturesample',
    what: 'diagnostic(off) + plain textureSample inside the non-uniform frost loop',
    expect: 'legal',
    src: 'diagnostic(off, derivative_uniformity);\n' + replaceOnce(
      wired, A_TEXSAMPLE_LOOP,
      '      let rg_s_rg = textureSample(u_pass0_tex_tex, u_pass0_tex_samp, rg_tap_rg);',
    ),
  })

  // --- explicit-gradient / explicit-LOD sampling in the branch ------------
  cases.push({
    id: 'W-texsamplegrad-in-branch',
    what: 'textureSampleGrad (explicit gradients) inside the non-uniform frost loop',
    expect: 'legal',
    src: (() => {
      let s = wired
      // Gradients must be computed at uniform CF, then passed in.
      s = insertBefore(s, A_IF,
        '  let fo_gx = dpdx(rg_sampleUV_rg);\n  let fo_gy = dpdy(rg_sampleUV_rg);')
      s = replaceOnce(s, A_TEXSAMPLE_LOOP,
        '      let rg_s_rg = textureSampleGrad(u_pass0_tex_tex, u_pass0_tex_samp, rg_tap_rg, fo_gx, fo_gy);')
      return s
    })(),
  })
  cases.push({
    id: 'W-texsamplebias-in-branch',
    what: 'textureSampleBias (implicit LOD) inside the non-uniform frost loop',
    expect: 'illegal',
    src: replaceOnce(wired, A_TEXSAMPLE_LOOP,
      '      let rg_s_rg = textureSampleBias(u_pass0_tex_tex, u_pass0_tex_samp, rg_tap_rg, 0.0);'),
  })

  // Sanity: the anchors we relied on must have existed in the *unmodified* file.
  if (!wired.includes(A_SAMPLEUV)) throw new Error('sampleUV anchor drifted')
  if (!wired.includes(A_LOOPBODY)) throw new Error('loop-body anchor drifted')

  return cases
}

function glslCases(): Case[] {
  const wired = read('wired-frost.glsl.pass1.frag')
  const A_MAIN = 'void main() {'
  const A_IF = '  if (rg_frost_rg > 0.001) {'
  const A_TEX_LOOP = '      vec4 rg_s_rg = texture(u_pass0_tex, rg_tap_rg);'
  const SINK = (v: string) => `  g_probe += ${v};`

  function live(src: string): string {
    let s = insertAfterLine(src, A_MAIN, '  float g_probe = 0.0;')
    s = replaceOnce(s, 'fragColor =', 'fragColor = vec4(0.0, 0.0, 0.0, g_probe * 1e-30) +')
    return s
  }

  const cases: Case[] = []

  cases.push({
    id: 'G-ctl-good', what: 'real emitted GLSL pass, unmodified',
    expect: 'legal', control: true, src: wired,
  })
  cases.push({
    id: 'G-ctl-bad-name', what: 'nonexistent builtin fwidthX()',
    expect: 'illegal', control: true,
    src: live(insertBefore(wired, A_IF, SINK('fwidthX(v_uv.x)'))),
  })
  cases.push({
    id: 'G-fwidth-top', what: 'fwidth/dFdx/dFdy at top level, no extension pragma',
    expect: 'legal',
    src: live(insertBefore(wired, A_IF, SINK('fwidth(v_uv.x) + dFdx(v_uv.x) + dFdy(v_uv.y)'))),
  })
  cases.push({
    id: 'G-fwidth-in-branch', what: 'fwidth inside the (possibly non-uniform) frost branch',
    expect: 'legal',
    src: live(insertAfterLine(wired, A_IF, '  ' + SINK('fwidth(rg_sampleUV_rg.x)'))),
  })
  cases.push({
    id: 'G-fwidth-in-loop', what: 'fwidth inside the frost for-loop',
    expect: 'legal',
    src: live(insertBefore(wired, A_TEX_LOOP, '    ' + SINK('fwidth(rg_tap_rg.x)'))),
  })
  cases.push({
    id: 'G-texture-in-branch', what: 'implicit-LOD texture() inside the frost branch (already shipping)',
    expect: 'legal', src: wired,
  })
  cases.push({
    id: 'G-ext-pragma', what: '#extension GL_OES_standard_derivatives : enable under #version 300 es',
    expect: 'legal',
    src: live(replaceOnce(wired, 'precision highp float;',
      '#extension GL_OES_standard_derivatives : enable\nprecision highp float;')),
  })
  cases.push({
    id: 'G-mediump', what: 'default precision mediump float — derivatives still compile',
    expect: 'legal',
    src: live(replaceOnce(insertBefore(wired, A_IF, SINK('fwidth(v_uv.x)')),
      'precision highp float;', 'precision mediump float;')),
  })
  cases.push({
    id: 'G-fwidthFine', what: 'fwidthFine() — a WGSL-only spelling — in GLSL ES 3.00',
    expect: 'illegal',
    src: live(insertBefore(wired, A_IF, SINK('fwidthFine(v_uv.x)'))),
  })
  cases.push({
    id: 'G-textureGrad-in-branch', what: 'textureGrad inside the frost loop',
    expect: 'legal',
    src: replaceOnce(wired, A_TEX_LOOP,
      '      vec4 rg_s_rg = textureGrad(u_pass0_tex, rg_tap_rg, dFdx(rg_sampleUV_rg), dFdy(rg_sampleUV_rg));'),
  })

  return cases
}

// ---------------------------------------------------------------------------
// Browser harness
// ---------------------------------------------------------------------------

const BROWSER_SIDE = /* js */ `
(() => {
  let dev = null;
  async function device() {
    if (dev) return dev;
    if (!navigator.gpu) return null;
    const a = await navigator.gpu.requestAdapter();
    if (!a) return null;
    dev = await a.requestDevice();
    dev.addEventListener('uncapturederror', (e) => { window.__lastUncaptured = String(e.error && e.error.message); });
    return dev;
  }

  async function compileWgsl(code) {
    const d = await device();
    if (!d) return { ok: false, fatal: 'no webgpu' };
    d.pushErrorScope('validation');
    const mod = d.createShaderModule({ code });
    const info = await mod.getCompilationInfo();
    const scopeErr = await d.popErrorScope();
    const msgs = Array.from(info.messages).map(m => ({ type: m.type, line: m.lineNum, text: m.message }));
    const errors = msgs.filter(m => m.type === 'error');
    const warnings = msgs.filter(m => m.type === 'warning');
    return {
      ok: true,
      moduleErrors: errors,
      moduleWarnings: warnings,
      moduleScopeError: scopeErr ? String(scopeErr.message) : null,
    };
  }

  // Does an invalid module silently produce a pipeline that drops the frame?
  async function pipelineProbe(code) {
    const d = await device();
    if (!d) return { ok: false, fatal: 'no webgpu' };
    const mod = d.createShaderModule({ code });
    d.pushErrorScope('validation');
    let threw = null;
    let pipeline = null;
    try {
      pipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs_main', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
        fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
    } catch (e) { threw = String(e && e.message); }
    const err = await d.popErrorScope();
    return { ok: true, createThrew: threw, createScopeError: err ? String(err.message) : null, gotPipeline: !!pipeline };
  }

  const GLSL_VERT = '#version 300 es\\nprecision highp float;\\nin vec2 a_position;\\nout vec2 v_uv;\\nvoid main(){ v_uv = a_position*0.5+0.5; gl_Position = vec4(a_position,0.0,1.0); }';

  function compileGlsl(fragSrc) {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok: false, fatal: 'no webgl2' };
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, GLSL_VERT); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc); gl.compileShader(fs);
    const fsOk = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
    const fsLog = gl.getShaderInfoLog(fs) || '';
    let linkOk = false, linkLog = '';
    if (fsOk && gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      linkOk = !!gl.getProgramParameter(p, gl.LINK_STATUS);
      linkLog = gl.getProgramInfoLog(p) || '';
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true, compiled: !!fsOk, compileLog: fsLog, linked: linkOk, linkLog,
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    };
  }

  window.__probe = { compileWgsl, compileGlsl, pipelineProbe, async info() {
    const d = await device();
    return { webgpu: !!d, adapter: d ? 'ok' : 'none' };
  } };
})();
`

interface WgslResult {
  ok: boolean
  fatal?: string
  moduleErrors?: Array<{ type: string; line: number; text: string }>
  moduleWarnings?: Array<{ type: string; line: number; text: string }>
  moduleScopeError?: string | null
}
interface GlslResult {
  ok: boolean
  fatal?: string
  compiled?: boolean
  compileLog?: string
  linked?: boolean
  linkLog?: string
  renderer?: string
  version?: string
}

async function main(): Promise<void> {
  const server = http.createServer((_r, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta charset="utf-8"><title>phase10</title>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const browser: Browser = await chromium.launch({
    channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'],
  })
  const page: Page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.addScriptTag({ content: BROWSER_SIDE })

  const results: Array<Record<string, unknown>> = []
  let miscalibrated = 0

  console.log('--- WGSL (Tint) ---')
  for (const c of wgslCases()) {
    const r = (await page.evaluate(
      async (code) => await (window as never as { __probe: { compileWgsl(c: string): Promise<WgslResult> } }).__probe.compileWgsl(code),
      c.src,
    )) as WgslResult
    if (!r.ok) throw new Error(`WGSL probe unavailable: ${r.fatal}`)
    const errs = r.moduleErrors ?? []
    const verdict: Expect = errs.length === 0 && !r.moduleScopeError ? 'legal' : 'illegal'
    const pass = verdict === c.expect
    if (!pass && c.control) miscalibrated++
    const first = errs[0]?.text?.split('\n')[0] ?? r.moduleScopeError ?? ''
    console.log(
      `${pass ? 'ok  ' : 'MISS'} ${c.id.padEnd(34)} expect=${c.expect.padEnd(7)} got=${verdict.padEnd(7)}` +
      `${(r.moduleWarnings ?? []).length ? ` [${(r.moduleWarnings ?? []).length} warn]` : ''} ${first.slice(0, 130)}`,
    )
    results.push({
      backend: 'wgsl', ...c, src: undefined, verdict, pass,
      errors: errs.map((e) => `L${e.line}: ${e.text.split('\n')[0]}`),
      warnings: (r.moduleWarnings ?? []).map((e) => `L${e.line}: ${e.text.split('\n')[0]}`),
      scopeError: r.moduleScopeError ?? null,
    })
  }

  // Does an invalid module silently yield a pipeline?
  const badSrc = wgslCases().find((c) => c.id === 'W-ctl-bad-uniformity')!.src
  const goodSrc = wgslCases().find((c) => c.id === 'W-ctl-good-wired')!.src
  for (const [tag, src] of [['good', goodSrc], ['uniformity-violating', badSrc]] as const) {
    const pr = await page.evaluate(
      async (code) => await (window as never as { __probe: { pipelineProbe(c: string): Promise<unknown> } }).__probe.pipelineProbe(code),
      src,
    )
    console.log(`pipeline[${tag}]`, JSON.stringify(pr))
    results.push({ backend: 'wgsl-pipeline', id: `pipeline-${tag}`, ...(pr as object) })
  }

  console.log('\n--- GLSL ES 3.00 (WebGL2) ---')
  for (const c of glslCases()) {
    const r = (await page.evaluate(
      (code) => (window as never as { __probe: { compileGlsl(c: string): GlslResult } }).__probe.compileGlsl(code),
      c.src,
    )) as GlslResult
    if (!r.ok) throw new Error(`GLSL probe unavailable: ${r.fatal}`)
    const verdict: Expect = r.compiled && r.linked ? 'legal' : 'illegal'
    const pass = verdict === c.expect
    if (!pass && c.control) miscalibrated++
    const log = ((r.compileLog ?? '') + ' ' + (r.linkLog ?? '')).trim().replace(/\s+/g, ' ')
    console.log(
      `${pass ? 'ok  ' : 'MISS'} ${c.id.padEnd(30)} expect=${c.expect.padEnd(7)} got=${verdict.padEnd(7)} ${log.slice(0, 150)}`,
    )
    results.push({ backend: 'glsl', ...c, src: undefined, verdict, pass, log, renderer: r.renderer, version: r.version })
  }

  // -------------------------------------------------------------------------
  // What does the mechanical GLSL->WGSL translator do with derivative calls?
  // Run the REAL translator (single-argument raw(), i.e. no hand-written WGSL
  // arm) over each spelling and print the WGSL it produces.
  // -------------------------------------------------------------------------
  console.log('\n--- mechanical GLSL -> WGSL translation of derivative calls ---')
  const xlate: Array<Record<string, string>> = []
  for (const glsl of [
    'float w = fwidth(coord);',
    'float a = dFdx(coord);',
    'float b = dFdy(coord);',
    'vec2 g = vec2(dFdx(uv.x), dFdy(uv.y));',
    'float c = fwidth(mod(coord, ribW));',
    'float d = fwidthFine(coord);',
    'float e = curvature > 1.0 ? fwidth(coord) : dFdx(coord);',
  ]) {
    const wgsl = lowerStmtToWGSL(raw(glsl))
    console.log(`  ${glsl.padEnd(54)} => ${wgsl}`)
    xlate.push({ glsl, wgsl })
  }

  fs.mkdirSync(DUMP_DIR, { recursive: true })
  fs.writeFileSync(OUT_JSON, JSON.stringify({ miscalibrated, results, translator: xlate }, null, 2))
  console.log(`\nwrote ${OUT_JSON}`)
  if (miscalibrated > 0) {
    console.log(`\n*** UNCALIBRATED: ${miscalibrated} control case(s) gave the wrong verdict. ***`)
    console.log('*** No "legal" result from this run may be trusted. ***')
  } else {
    console.log('\nAll control cases behaved as expected — gate is calibrated.')
  }

  await browser.close()
  server.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
