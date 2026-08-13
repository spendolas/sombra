/**
 * Registers the built-in FrameSinks (Task 5) with the sink registry.
 * Import for side effect once from the app (the ExportModal entry point,
 * Task 7) before reading `getAvailableSinks`/`getSinks`.
 */

import { registerSink } from '../registry'
import { makeMp4Sink } from './webcodecs-mp4'
import { makeWebmAlphaSink } from './webm-alpha'
import { makePngSequenceSink } from './png-sequence'

registerSink(makeMp4Sink())
registerSink(makeWebmAlphaSink())
registerSink(makePngSequenceSink())
