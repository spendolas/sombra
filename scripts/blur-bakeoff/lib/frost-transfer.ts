// Phase 9 transfer: the frost block AS IT WOULD BE WRITTEN INTO
// src/nodes/transform/reeded-glass.ts, for each variant under test.
//
// Nothing here is shipped. These strings exist so the winner can be compiled by
// the real Sombra compiler (glsl-generator + ir-compiler + wgsl-assembler) and
// then by a real Tint / WebGL2 driver, which is the only way to know whether the
// bench result survives the transfer.
//
// Every variant emits BOTH arms explicitly (two-argument raw()), because a
// hand-written WGSL arm skips mechanical translation entirely. The one variant
// that does NOT (`winnerMechanical`) is a positive control: it must be rejected.

export interface FrostNames {
  /** node id with '-' → '_' */
  id: string
  /** the node's colour output variable */
  color: string
  /** inter-pass sampler base name (e.g. u_pass0) */
  sampler: string
  /** the `float rg_frost_<id>` variable already declared by the node */
  frost: string
  /** rg_coords_<id> — frozen-ref, SRT-applied, y-DOWN on both backends */
  coords: string
  /** rg_sampleUV_<id> — the lens-displaced sample UV */
  sampleUV: string
}

export interface FrostBlock {
  glsl: string
  /** undefined => single-argument raw(), i.e. mechanical translation. */
  wgsl?: string
}

const TAU = '6.28318530718'
const GOLDEN = '2.39996323'

/** cos/sin of i*goldenAngle, baked. Matches sunflowerOffsets() direction exactly. */
function bakedDir(i: number): { dx: string; dy: string } {
  const th = i * (Math.PI * (3 - Math.sqrt(5)))
  const f = (v: number) => {
    const s = v.toPrecision(9)
    return /[.eE]/.test(s) ? s : `${s}.0`
  }
  return { dx: f(Math.cos(th)), dy: f(Math.sin(th)) }
}

// ---------------------------------------------------------------------------
// C0 — exactly what ships today (control; must reproduce the node byte-for-byte
// modulo whitespace)
// ---------------------------------------------------------------------------
export function shipped(n: FrostNames): FrostBlock {
  const { id, color, sampler, frost, coords, sampleUV } = n
  return {
    glsl: `vec4 ${color};
  if (${frost} > 0.001) {
    vec3 rg_acc_${id} = vec3(0.0);
    float rg_aacc_${id} = 0.0;
    vec2 rg_frad_${id} = vec2(${frost} * 24.0 * u_dpr) / u_viewport;
    vec2 rg_gc_${id} = floor(${coords} * (u_ref_size * 0.25));
    for (int rg_i_${id} = 0; rg_i_${id} < 8; rg_i_${id}++) {
      vec2 rg_jit_${id} = reedHash(rg_gc_${id} + vec2(float(rg_i_${id}) * 7.31, float(rg_i_${id}) * -11.13)) * rg_frad_${id};
      vec2 rg_tap_${id} = ${sampleUV} + rg_jit_${id};
      rg_tap_${id} = 1.0 - abs(fract(rg_tap_${id} * 0.5) * 2.0 - 1.0);
      vec4 rg_s_${id} = texture(${sampler}, rg_tap_${id});
      rg_acc_${id} += rg_s_${id}.rgb * rg_s_${id}.a;
      rg_aacc_${id} += rg_s_${id}.a;
    }
    ${color} = vec4(rg_acc_${id} / max(rg_aacc_${id}, 1e-5), rg_aacc_${id} / 8.0);
  } else {
    ${color} = texture(${sampler}, ${sampleUV});
  }`,
    wgsl: `var ${color}: vec4f;
  if (${frost} > 0.001) {
    var rg_acc_${id}: vec3f = vec3f(0.0);
    var rg_aacc_${id}: f32 = 0.0;
    let rg_frad_${id} = vec2f(${frost} * 24.0 * uniforms.u_dpr) / uniforms.u_viewport;
    let rg_gc_${id} = floor(${coords} * (uniforms.u_ref_size * 0.25));
    for (var rg_i_${id}: i32 = 0; rg_i_${id} < 8; rg_i_${id}++) {
      let rg_jit_${id} = reedHash(rg_gc_${id} + vec2f(f32(rg_i_${id}) * 7.31, f32(rg_i_${id}) * -11.13)) * rg_frad_${id};
      var rg_tap_${id} = ${sampleUV} + rg_jit_${id};
      rg_tap_${id} = vec2f(1.0) - abs(fract(rg_tap_${id} * 0.5) * vec2f(2.0) - vec2f(1.0));
      let rg_s_${id} = textureSampleLevel(${sampler}_tex, ${sampler}_samp, rg_tap_${id}, 0.0);
      rg_acc_${id} = rg_acc_${id} + rg_s_${id}.rgb * rg_s_${id}.a;
      rg_aacc_${id} = rg_aacc_${id} + rg_s_${id}.a;
    }
    ${color} = vec4f(rg_acc_${id} / vec3f(max(rg_aacc_${id}, 1e-5)), rg_aacc_${id} / 8.0);
  } else {
    ${color} = textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${sampleUV}, 0.0);
  }`,
  }
}

// ---------------------------------------------------------------------------
// C3j-16 transferred VERBATIM from the bench: seed = floor(fragCoord.xy),
// procedural loop, one cos+sin per tap.
// ---------------------------------------------------------------------------
export function winnerNaive(n: FrostNames, taps = 16): FrostBlock {
  const { id, color, sampler, frost, sampleUV } = n
  const invN = (1 / taps).toPrecision(9)
  return {
    glsl: `vec4 ${color};
  if (${frost} > 0.001) {
    vec3 rg_acc_${id} = vec3(0.0);
    float rg_aacc_${id} = 0.0;
    vec2 rg_frad_${id} = vec2(${frost} * 24.0 * u_dpr) / u_viewport;
    vec2 rg_gc_${id} = floor(gl_FragCoord.xy);
    float rg_rot_${id} = (reedHash(rg_gc_${id} + vec2(11.7, -23.9)).x * 0.5 + 0.5) * ${TAU};
    for (int rg_i_${id} = 0; rg_i_${id} < ${taps}; rg_i_${id}++) {
      float rg_fi_${id} = float(rg_i_${id});
      float rg_jr_${id} = reedHash(rg_gc_${id} + vec2(rg_fi_${id} * 3.17 + 0.5, rg_fi_${id} * -5.41 - 0.5)).y * 0.5 + 0.5;
      float rg_ri_${id} = sqrt((rg_fi_${id} + rg_jr_${id}) * ${invN});
      float rg_th_${id} = rg_rot_${id} + rg_fi_${id} * ${GOLDEN};
      vec2 rg_tap_${id} = ${sampleUV} + vec2(cos(rg_th_${id}), sin(rg_th_${id})) * rg_ri_${id} * rg_frad_${id};
      rg_tap_${id} = 1.0 - abs(fract(rg_tap_${id} * 0.5) * 2.0 - 1.0);
      vec4 rg_s_${id} = texture(${sampler}, rg_tap_${id});
      rg_acc_${id} += rg_s_${id}.rgb * rg_s_${id}.a;
      rg_aacc_${id} += rg_s_${id}.a;
    }
    ${color} = vec4(rg_acc_${id} / max(rg_aacc_${id}, 1e-5), rg_aacc_${id} / ${taps}.0);
  } else {
    ${color} = texture(${sampler}, ${sampleUV});
  }`,
    wgsl: `var ${color}: vec4f;
  if (${frost} > 0.001) {
    var rg_acc_${id}: vec3f = vec3f(0.0);
    var rg_aacc_${id}: f32 = 0.0;
    let rg_frad_${id} = vec2f(${frost} * 24.0 * uniforms.u_dpr) / uniforms.u_viewport;
    let rg_gc_${id} = floor(in.position.xy);
    let rg_rot_${id} = (reedHash(rg_gc_${id} + vec2f(11.7, -23.9)).x * 0.5 + 0.5) * ${TAU};
    for (var rg_i_${id}: i32 = 0; rg_i_${id} < ${taps}; rg_i_${id}++) {
      let rg_fi_${id} = f32(rg_i_${id});
      let rg_jr_${id} = reedHash(rg_gc_${id} + vec2f(rg_fi_${id} * 3.17 + 0.5, rg_fi_${id} * -5.41 - 0.5)).y * 0.5 + 0.5;
      let rg_ri_${id} = sqrt((rg_fi_${id} + rg_jr_${id}) * ${invN});
      let rg_th_${id} = rg_rot_${id} + rg_fi_${id} * ${GOLDEN};
      var rg_tap_${id} = ${sampleUV} + vec2f(cos(rg_th_${id}), sin(rg_th_${id})) * rg_ri_${id} * rg_frad_${id};
      rg_tap_${id} = vec2f(1.0) - abs(fract(rg_tap_${id} * 0.5) * vec2f(2.0) - vec2f(1.0));
      let rg_s_${id} = textureSampleLevel(${sampler}_tex, ${sampler}_samp, rg_tap_${id}, 0.0);
      rg_acc_${id} = rg_acc_${id} + rg_s_${id}.rgb * rg_s_${id}.a;
      rg_aacc_${id} = rg_aacc_${id} + rg_s_${id}.a;
    }
    ${color} = vec4f(rg_acc_${id} / vec3f(max(rg_aacc_${id}, 1e-5)), rg_aacc_${id} / ${taps}.0);
  } else {
    ${color} = textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${sampleUV}, 0.0);
  }`,
  }
}

// ---------------------------------------------------------------------------
// Same kernel, seeded from rg_coords (y-DOWN and identical on both backends,
// SRT-locked, anchor-pinned) scaled to one seed per DEVICE pixel.
// ---------------------------------------------------------------------------
export function winnerSeedFixed(n: FrostNames, taps = 16): FrostBlock {
  const b = winnerNaive(n, taps)
  return {
    glsl: b.glsl.replace(
      `floor(gl_FragCoord.xy)`,
      `floor(${n.coords} * (u_dpr * u_ref_size))`,
    ),
    wgsl: b.wgsl!.replace(
      `floor(in.position.xy)`,
      `floor(${n.coords} * (uniforms.u_dpr * uniforms.u_ref_size))`,
    ),
  }
}

// ---------------------------------------------------------------------------
// Shippable form: seed fix + unrolled taps with BAKED unit directions rotated by
// one per-fragment (cos, sin). Mathematically identical to winnerSeedFixed
// (cos(rot+a) = cos rot cos a - sin rot sin a) at 2 transcendentals per fragment
// instead of 2N.
// ---------------------------------------------------------------------------
export function winnerFinal(n: FrostNames, taps = 16): FrostBlock {
  const { id, color, sampler, frost, coords, sampleUV } = n
  const invN = (1 / taps).toPrecision(9)
  const g: string[] = []
  const w: string[] = []
  for (let i = 0; i < taps; i++) {
    const { dx, dy } = bakedDir(i)
    g.push(
      `    float rg_jr${i}_${id} = reedHash(rg_gc_${id} + vec2(${(i * 3.17 + 0.5).toPrecision(9)}, ${(i * -5.41 - 0.5).toPrecision(9)})).y * 0.5 + 0.5;`,
      `    float rg_ri${i}_${id} = sqrt((${i}.0 + rg_jr${i}_${id}) * ${invN});`,
      `    vec2 rg_tap${i}_${id} = ${sampleUV} + vec2(rg_cr_${id} * ${dx} - rg_sr_${id} * ${dy}, rg_sr_${id} * ${dx} + rg_cr_${id} * ${dy}) * rg_ri${i}_${id} * rg_frad_${id};`,
      `    rg_tap${i}_${id} = 1.0 - abs(fract(rg_tap${i}_${id} * 0.5) * 2.0 - 1.0);`,
      `    vec4 rg_s${i}_${id} = texture(${sampler}, rg_tap${i}_${id});`,
      `    rg_acc_${id} += rg_s${i}_${id}.rgb * rg_s${i}_${id}.a;`,
      `    rg_aacc_${id} += rg_s${i}_${id}.a;`,
    )
    w.push(
      `    let rg_jr${i}_${id} = reedHash(rg_gc_${id} + vec2f(${(i * 3.17 + 0.5).toPrecision(9)}, ${(i * -5.41 - 0.5).toPrecision(9)})).y * 0.5 + 0.5;`,
      `    let rg_ri${i}_${id} = sqrt((${i}.0 + rg_jr${i}_${id}) * ${invN});`,
      `    var rg_tap${i}_${id} = ${sampleUV} + vec2f(rg_cr_${id} * ${dx} - rg_sr_${id} * ${dy}, rg_sr_${id} * ${dx} + rg_cr_${id} * ${dy}) * rg_ri${i}_${id} * rg_frad_${id};`,
      `    rg_tap${i}_${id} = vec2f(1.0) - abs(fract(rg_tap${i}_${id} * 0.5) * vec2f(2.0) - vec2f(1.0));`,
      `    let rg_s${i}_${id} = textureSampleLevel(${sampler}_tex, ${sampler}_samp, rg_tap${i}_${id}, 0.0);`,
      `    rg_acc_${id} = rg_acc_${id} + rg_s${i}_${id}.rgb * rg_s${i}_${id}.a;`,
      `    rg_aacc_${id} = rg_aacc_${id} + rg_s${i}_${id}.a;`,
    )
  }
  return {
    glsl: `vec4 ${color};
  if (${frost} > 0.001) {
    vec3 rg_acc_${id} = vec3(0.0);
    float rg_aacc_${id} = 0.0;
    vec2 rg_frad_${id} = vec2(${frost} * 24.0 * u_dpr) / u_viewport;
    vec2 rg_gc_${id} = floor(${coords} * (u_dpr * u_ref_size));
    float rg_rot_${id} = (reedHash(rg_gc_${id} + vec2(11.7, -23.9)).x * 0.5 + 0.5) * ${TAU};
    float rg_cr_${id} = cos(rg_rot_${id});
    float rg_sr_${id} = sin(rg_rot_${id});
${g.join('\n')}
    ${color} = vec4(rg_acc_${id} / max(rg_aacc_${id}, 1e-5), rg_aacc_${id} / ${taps}.0);
  } else {
    ${color} = texture(${sampler}, ${sampleUV});
  }`,
    wgsl: `var ${color}: vec4f;
  if (${frost} > 0.001) {
    var rg_acc_${id}: vec3f = vec3f(0.0);
    var rg_aacc_${id}: f32 = 0.0;
    let rg_frad_${id} = vec2f(${frost} * 24.0 * uniforms.u_dpr) / uniforms.u_viewport;
    let rg_gc_${id} = floor(${coords} * (uniforms.u_dpr * uniforms.u_ref_size));
    let rg_rot_${id} = (reedHash(rg_gc_${id} + vec2f(11.7, -23.9)).x * 0.5 + 0.5) * ${TAU};
    let rg_cr_${id} = cos(rg_rot_${id});
    let rg_sr_${id} = sin(rg_rot_${id});
${w.join('\n')}
    ${color} = vec4f(rg_acc_${id} / vec3f(max(rg_aacc_${id}, 1e-5)), rg_aacc_${id} / ${taps}.0);
  } else {
    ${color} = textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${sampleUV}, 0.0);
  }`,
  }
}

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS — each must FAIL, or the harness proves nothing.
// ---------------------------------------------------------------------------

/** Single-argument raw(): mechanical translation emits textureSample. Must be
 *  rejected by Tint under a non-uniform `frost` branch. */
export function winnerMechanical(n: FrostNames, taps = 16): FrostBlock {
  return { glsl: winnerNaive(n, taps).glsl } // no wgsl arm on purpose
}

/** Guaranteed-invalid GLSL, to prove the WebGL2 half of the harness can fail. */
export function glslBadControl(n: FrostNames): FrostBlock {
  const b = winnerNaive(n, 16)
  return {
    glsl: b.glsl.replace(`texture(${n.sampler}, rg_tap_${n.id})`,
      `textureSampleLevel(${n.sampler}_tex, ${n.sampler}_samp, rg_tap_${n.id}, 0.0)`),
    wgsl: b.wgsl,
  }
}

/** Was assumed to be a hard constraint. GLSL ES 3.00 dropped the ES-1.00
 *  constant-loop-bound rule, so this is INFORMATIONAL: it is expected to
 *  compile, and the run records whether this driver enforces anything. */
export function winnerDynamicLoop(n: FrostNames): FrostBlock {
  const b = winnerNaive(n, 16)
  return {
    glsl: b.glsl.replace(
      `rg_i_${n.id} < 16;`,
      `float(rg_i_${n.id}) < ${n.frost} * 16.0;`,
    ),
    wgsl: b.wgsl,
  }
}

/** The y-flip trap: WGSL arm writes gl_FragCoord and lets the assembler rewrite
 *  it. Compiles fine on both — the defect is silent, which is the point. */
export function winnerYFlipTrap(n: FrostNames): FrostBlock {
  const b = winnerNaive(n, 16)
  return { glsl: b.glsl, wgsl: b.wgsl!.replace('floor(in.position.xy)', 'floor(gl_FragCoord.xy)') }
}
