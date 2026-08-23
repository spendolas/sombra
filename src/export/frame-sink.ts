export type QualityLevel = 'draft' | 'good' | 'high' | 'max'
export interface SinkOpts { width: number; height: number; fps: number; alpha: boolean; matte?: string; quality: QualityLevel }
export interface FrameSink {
  readonly id: string
  readonly label: string
  readonly supportsAlpha: boolean
  readonly output: 'file' | 'zip'
  readonly tier: 'free' | 'pro'
  readonly fileExt: string              // 'mp4' | 'webm' | 'zip'
  readonly mimeType: string             // 'video/mp4' | 'video/webm' | 'application/zip'
  isSupported(): Promise<boolean>       // runtime feature detection
  /** Begin encoding, streaming all output bytes into `writable` (append-only). */
  begin(o: SinkOpts, writable: WritableStream<Uint8Array>): Promise<void>
  addFrame(frame: VideoFrame, timestampUs: number): Promise<void>  // sink may also read ImageData internally
  /** Flush the encoder and CLOSE the writable. No Blob — bytes already streamed out. */
  finish(): Promise<void>
  /**
   * Deterministic cancel/failure teardown. Stops the encoder (mediabunny
   * `Output.cancel()` / fflate `Zip.terminate()`), then RELEASES this sink's
   * writer and ABORTS the destination writable — which on the File System Access
   * path discards the swap file rather than leaking its handle to GC. Safe to
   * call before `begin()` (no-op) and idempotent; never throws (best-effort).
   */
  abort(): Promise<void>
}
