/** File-drop classification, extensibility, and image-import mechanism checks. */
import { readFileSync } from 'node:fs'
import { initializeNodeLibrary } from '../src/nodes'
import {
  classifyDropFiles,
  dropEffectForClassification,
  type DropFormatDefinition,
} from '../src/utils/file-drop'
import {
  buildDroppedImageNodes,
  importDroppedProject,
  projectReplacementPrompt,
} from '../src/utils/file-drop-import'

initializeNodeLibrary()

let passed = 0
let failed = 0
function check(name: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  [PASS] ${name}`)
  } else {
    failed++
    console.error(`  [FAIL] ${name}`)
  }
}

console.log('\nA. Pre-drop format classification')
const mimeOnlyImage = classifyDropFiles([{ name: '', type: 'image/png' }])
check(
  'image MIME classifies before the browser exposes a filename',
  mimeOnlyImage.status === 'accepted' && mimeOnlyImage.format.id === 'image',
)

const extensionImage = classifyDropFiles([{ name: 'PHOTO.JPEG', type: '' }])
check(
  'image extension fallback is case-insensitive',
  extensionImage.status === 'accepted' && extensionImage.format.id === 'image',
)

const imageBatch = classifyDropFiles([
  { name: 'a.png', type: 'image/png' },
  { name: 'b.webp', type: 'image/webp' },
  { name: 'c.gif', type: 'image/gif' },
])
check(
  'multiple supported images form one append batch',
  imageBatch.status === 'accepted'
    && imageBatch.format.id === 'image'
    && imageBatch.fileCount === 3,
)

const project = classifyDropFiles([{ name: 'material.SOMBRA', type: 'application/octet-stream' }])
check(
  '.sombra extension classifies as a replacing project drop',
  project.status === 'accepted'
    && project.format.id === 'sombra-project'
    && project.format.operation === 'replace',
)

check(
  'mixed image/project drops are rejected',
  classifyDropFiles([
    { name: 'a.png', type: 'image/png' },
    { name: 'project.sombra', type: 'application/octet-stream' },
  ]).status === 'mixed',
)
check(
  'multiple project files are rejected',
  classifyDropFiles([
    { name: 'a.sombra', type: '' },
    { name: 'b.sombra', type: '' },
  ]).status === 'unsupported',
)
check(
  'unsupported named files are rejected before drop',
  classifyDropFiles([{ name: 'notes.txt', type: 'text/plain' }]).status === 'unsupported',
)
check(
  'browser-protected unknown names stay unresolved rather than falsely rejected',
  classifyDropFiles([{ name: '', type: 'application/octet-stream' }]).status === 'unresolved',
)
const protectedProject = classifyDropFiles([{ name: '', type: 'application/octet-stream' }])
check(
  'unresolved files remain droppable so release can expose the .sombra extension',
  dropEffectForClassification(protectedProject) === 'copy',
)
check(
  'explicitly unsupported files retain a rejected drop effect',
  dropEffectForClassification(classifyDropFiles([{ name: 'notes.txt', type: 'text/plain' }])) === 'none',
)
const mimeProject = classifyDropFiles([{ name: '', type: 'application/x-sombra' }])
check(
  'Sombra MIME type identifies projects before filename release when preserved',
  mimeProject.status === 'accepted' && mimeProject.format.id === 'sombra-project',
)

console.log('\nB. New-format extension point')
const futureFormats = [{
  id: 'lut',
  operation: 'append',
  multiple: true,
  extensions: ['.cube'],
  mimeTypes: ['application/x-cube-lut'],
  overlay: {
    icon: 'paintBucket',
    tone: 'indigo',
    title: (count: number) => `Add ${count} LUT`,
    busyTitle: () => 'Reading LUT…',
    detail: 'Adds a color lookup node.',
  },
}] as const satisfies readonly DropFormatDefinition[]
const future = classifyDropFiles([{ name: 'cinema.cube', type: '' }], futureFormats)
check(
  'a descriptor alone teaches the classifier a future format',
  future.status === 'accepted'
    && future.format.id === 'lut'
    && future.format.overlay.busyTitle(1) === 'Reading LUT…',
)

console.log('\nC. Image downscaler boundary and node construction')
const processorCalls: string[] = []
const dropped = [
  { name: 'first.png' },
  { name: 'broken.jpg' },
  { name: 'third.webp' },
]
const built = await buildDroppedImageNodes(
  dropped,
  { x: 100, y: 200 },
  async (file) => {
    processorCalls.push(file.name)
    if (file.name === 'broken.jpg') throw new Error('decode failed')
    return {
      dataUrl: `data:image/webp;base64,${file.name}`,
      width: 1024,
      height: 512,
      aspect: 2,
    }
  },
)
check('every dropped image engages the injected processor', processorCalls.join('|') === dropped.map((f) => f.name).join('|'))
check('one node is created per successfully processed image', built.nodes.length === 2)
check('decode failures are isolated without dropping successful images', built.failures.length === 1 && built.failures[0].file.name === 'broken.jpg')
check('processed data URL reaches the Image node', built.nodes[0].data.params?.imageData === 'data:image/webp;base64,first.png')
check('processed dimensions/aspect reach the Image node',
  built.nodes[0].data.params?.imageWidth === 1024
  && built.nodes[0].data.params?.imageHeight === 512
  && built.nodes[0].data.params?.imageAspect === 2,
)
check('multi-image placement fans out from the drop point',
  built.nodes[0].position.x === 100
  && built.nodes[0].position.y === 200
  && (built.nodes[1].position.x !== built.nodes[0].position.x
    || built.nodes[1].position.y !== built.nodes[0].position.y),
)
check('created Image nodes receive distinct IDs', built.nodes[0].id !== built.nodes[1].id)

console.log('\nD. Project replacement confirmation')
const replacementPrompt = projectReplacementPrompt('favorite.sombra')
check('confirmation names the project', replacementPrompt.title.includes('favorite.sombra'))
check('confirmation explains close/replace and undo semantics',
  replacementPrompt.detail.includes('close the current project')
  && replacementPrompt.detail.includes('replace the canvas')
  && replacementPrompt.detail.includes('undo'),
)

const importEvents: string[] = []
const projectFile = { name: 'favorite.sombra' }
const importedProject = await importDroppedProject(projectFile, {
  confirmReplacement: ({ filename, thumbnail }) => {
    importEvents.push(`confirm:${filename}:${thumbnail?.dataUrl ?? 'none'}`)
    return true
  },
  readFile: async () => {
    importEvents.push('read')
    return {
      nodes: [],
      edges: [],
      thumbnail: {
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,preview',
      },
    }
  },
  validate: (payload) => {
    importEvents.push('validate')
    return payload as { nodes: []; edges: [] }
  },
  normalizeImages: async (nodes) => {
    importEvents.push('normalize')
    return nodes
  },
  loadGraph: () => { importEvents.push('load') },
})
check('project drop completes the replacement pipeline', importedProject === true)
check(
  'project preview is read and validated before the confirmation dialog opens',
  importEvents.join('|') === 'read|validate|confirm:favorite.sombra:data:image/webp;base64,preview|normalize|load',
)

let cancelledReadCount = 0
const cancelledProject = await importDroppedProject(projectFile, {
  confirmReplacement: () => false,
  readFile: async () => {
    cancelledReadCount++
    return { nodes: [], edges: [] }
  },
  validate: () => ({ nodes: [], edges: [] }),
  normalizeImages: async (nodes) => nodes,
  loadGraph: () => undefined,
})
check('cancelling a project drop still reads the file once but leaves the graph untouched',
  cancelledProject === false && cancelledReadCount === 1,
)

console.log('\nE. React Flow event interception')
const flowCanvasSource = readFileSync(new URL('../src/components/FlowCanvas.tsx', import.meta.url), 'utf8')
const fileDropOverlaySource = readFileSync(new URL('../src/components/FileDropOverlay.tsx', import.meta.url), 'utf8')
const actionButtonClassSource = readFileSync(new URL('../src/components/action-button-class.ts', import.meta.url), 'utf8')
const exportModalSource = readFileSync(new URL('../src/export/ExportModal.tsx', import.meta.url), 'utf8')
check(
  'file router intercepts drops during capture before React Flow handles them',
  flowCanvasSource.includes('onDropCapture={(event) => { void onFileDrop(event) }}'),
)
check(
  'file drop interception prevents React Flow from consuming the event',
  /const onFileDrop[\s\S]*?event\.preventDefault\(\)\s*event\.stopPropagation\(\)/.test(flowCanvasSource),
)
check(
  'drop workflow contains no browser-native alert or confirmation modal',
  !flowCanvasSource.includes('window.alert')
    && !flowCanvasSource.includes('window.confirm')
    && !readFileSync(new URL('../src/utils/file-drop-import.ts', import.meta.url), 'utf8').includes('window.confirm'),
)
check(
  'file dialog consumes every registered generated DS part',
  ['root', 'panel', 'title', 'detail', 'actions']
    .every((part) => fileDropOverlaySource.includes(`ds.fileDropDialog.${part}`)),
)
check(
  'file dialog and video export share the registered Action Button component',
  fileDropOverlaySource.includes('<ActionButton')
    && exportModalSource.includes('<ActionButton')
    && exportModalSource.includes("actionButtonClass('primary')"),
)
check(
  'Action Button resolves enabled and disabled variants through generated DS parts',
  ['secondary', 'primary', 'primaryDisabled']
    .every((part) => actionButtonClassSource.includes(`ds.actionButton.${part}`)),
)

console.log('\n' + '='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
