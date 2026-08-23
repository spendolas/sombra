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
}
