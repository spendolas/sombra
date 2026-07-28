/**
 * Phase 14b — put a CANDIDATE adaptive-supersample loop through the real
 * mechanical GLSL→WGSL translator (`lowerStmtToWGSL(raw(glsl))`, no wgsl arm) and
 * print what comes out, line by line, so the report names the exact lines that
 * need a hand-written WGSL arm rather than guessing from the regex list.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase14-xlate-probe.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { raw } from '../../src/compiler/ir/types'
import { lowerStmtToWGSL } from '../../src/compiler/ir/wgsl-backend'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase14')

const CASES: Array<{ id: string; glsl: string }> = [
  {
    id: 'A-forloop-decls-break-ternary',
    glsl: `float rg_mag_x = 1.0;
int rg_n_x = 4;
vec3 rg_sacc_x = vec3(0.0);
float rg_sw_x = 0.0;
bool rg_super_x = rg_mag_x > 1.0;
float rg_stepPx_x = 1.0 / float(rg_n_x);
for (int rg_k_x = 0; rg_k_x < 16; rg_k_x++) {
  if (rg_k_x >= rg_n_x) break;
  float rg_fk_x = (float(rg_k_x) + 0.5) * rg_stepPx_x - 0.5;
  float rg_wk_x = rg_super_x ? 1.0 : 0.0;
  vec2 rg_tk_x = vec2(rg_fk_x, 0.0);
  vec4 rg_ck_x = texture(u_pass0_tex, rg_tk_x);
  rg_sacc_x += rg_ck_x.rgb * rg_ck_x.a * rg_wk_x;
  rg_sw_x += rg_ck_x.a * rg_wk_x;
}`,
  },
  {
    id: 'B-inline-decl-inside-oneline-body',
    glsl: `for (int rg_k_x = 0; rg_k_x < 4; rg_k_x++) { float rg_q_x = float(rg_k_x); rg_sw_x += rg_q_x; }`,
  },
  {
    id: 'C-const-array-offsets',
    glsl: `const vec2 rg_off_x[2] = vec2[2](vec2(-0.25, 0.0), vec2(0.25, 0.0));
vec2 rg_o_x = rg_off_x[0];`,
  },
  {
    id: 'D-mod-and-nested-ternary',
    glsl: `float rg_l_x = mod(rg_swm_x, rg_ribUV_scr_x) / rg_ribUV_scr_x;
float rg_a_x = rg_mag_x > 8.0 ? 16.0 : (rg_mag_x > 2.0 ? 8.0 : 4.0);`,
  },
  {
    id: 'E-braceless-for-and-if',
    glsl: `for (int rg_k_x = 0; rg_k_x < 4; rg_k_x++)
  rg_sw_x += 1.0;
if (rg_mag_x > 1.0) rg_sw_x = 0.0;`,
  },
  {
    id: 'F-int-uniform-loop-bound-nonconst',
    glsl: `int rg_nn_x = int(min(ceil(rg_mag_x), 16.0));
for (int rg_k_x = 0; rg_k_x < rg_nn_x; rg_k_x++) rg_sw_x += 1.0;`,
  },
  {
    id: 'G-textureLod-vs-texture',
    glsl: `vec4 rg_c_x = textureLod(u_pass0_tex, rg_tk_x, 0.0);`,
  },
]

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out: string[] = []
  for (const c of CASES) {
    out.push(`\n===== ${c.id} =====`)
    out.push('--- GLSL in ---')
    c.glsl.split('\n').forEach((l, i) => out.push(`${String(i + 1).padStart(3)} ${l}`))
    out.push('--- WGSL out (mechanical) ---')
    lowerStmtToWGSL(raw(c.glsl)).split('\n').forEach((l, i) => out.push(`${String(i + 1).padStart(3)} ${l}`))
  }
  const text = out.join('\n')
  fs.writeFileSync(path.join(OUT_DIR, 'xlate-probe.txt'), text)
  console.log(text)
}

main()
