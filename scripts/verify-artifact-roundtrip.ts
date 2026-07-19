/**
 * verify-artifact-roundtrip — the SceneArtifact codec must be lossless, and the
 * player's vertex constant must match the compiler's. Part of the script-based
 * test suite: run with `npx tsx scripts/verify-artifact-roundtrip.ts`.
 */
import { encodeArtifact, decodeArtifact, type SceneArtifact } from '../src/embed/artifact'
import { GLSL_VERTEX_SHADER } from '../src/embed/vertex'
import { VERTEX_SHADER } from '../src/compiler/glsl-generator'

let passed = 0
let failed = 0
function check(name: string, cond: boolean) {
  if (cond) { passed++ } else { failed++; console.error(`  [FAIL] ${name}`) }
}

// 1. Vertex-constant invariant.
check('player vertex constant equals compiler VERTEX_SHADER', GLSL_VERTEX_SHADER === VERTEX_SHADER)

// 2. Codec round-trip on a representative synthetic artifact.
const artifact: SceneArtifact = {
  v: 1,
  kind: 'frozen',
  plan: {
    success: true,
    passes: [{
      index: 0,
      fragmentShader: '#version 300 es\nprecision highp float;\nout vec4 o;\nuniform float u_a_scale;\nvoid main(){o=vec4(u_a_scale);}',
      userUniforms: [{ name: 'u_a_scale', glslType: 'float', value: 0.5, nodeId: 'a', paramId: 'scale' }],
      inputTextures: {},
      isTimeLive: false,
    }],
    errors: [],
    isTimeLiveAtOutput: false,
    qualityTier: 'adaptive',
    fragmentShader: 'unused-top-level',
    userUniforms: [{ name: 'u_a_scale', glslType: 'float', value: 0.5, nodeId: 'a', paramId: 'scale' }],
  } as SceneArtifact['plan'],
  manifest: [{
    key: 'scale', uniform: 'u_a_scale', label: 'Scale',
    type: 'float', glslType: 'float', min: 0, max: 1, step: 0.01, default: 0.5,
  }],
  images: [{ sampler: 'u_b_image', dataUrl: 'data:image/png;base64,AAAA' }],
  meta: { anchor: [0.5, 0.5], timeSpeed: 1 },
}

const decoded = decodeArtifact(encodeArtifact(artifact))
check('round-trips deep-equal', JSON.stringify(decoded) === JSON.stringify(artifact))
check('decoded artifact has no vertexShader in passes', !('vertexShader' in decoded.plan.passes[0]))

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
