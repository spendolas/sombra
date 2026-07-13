/**
 * grip-client.ts — minimal MCP client for the local Grip bridge.
 *
 * Grip (Dropbox/Tools/Figma Plugins/Grip) is a Figma plugin + local bridge
 * daemon. The bridge accepts MCP sessions over a unix socket speaking
 * newline-delimited JSON-RPC (same channel the agent-side MCP proxy uses),
 * which gives scripts full Figma Plugin API access — variables, styles,
 * components, arbitrary run_script — with NO Figma REST token.
 *
 * Requirements at call time: the bridge daemon is running and the Grip
 * plugin is open in the target Figma file (desktop app).
 */

import { connect, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IPC_PATH = process.env.GRIP_IPC_PATH ?? join(tmpdir(), 'grip-bridge.sock')

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

export class GripClient {
  private socket!: Socket
  private buf = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  static available(): boolean {
    return existsSync(IPC_PATH)
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket = connect(IPC_PATH)
      this.socket.setEncoding('utf8')
      this.socket.once('connect', () => resolve())
      this.socket.once('error', (err) => reject(new Error(`Grip bridge unreachable at ${IPC_PATH}: ${err.message}`)))
      this.socket.on('data', (chunk: string) => this.onData(chunk))
    })

    // MCP handshake
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sombra-ds-pipeline', version: '1.0.0' },
    })
    this.notify('notifications/initialized', {})
  }

  private onData(chunk: string) {
    this.buf += chunk
    let idx: number
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id === undefined) continue // server notification — ignore
      const waiter = this.pending.get(msg.id)
      if (!waiter) continue
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(`grip: ${msg.error.message}`))
      else waiter.resolve(msg.result)
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const p = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`grip: ${method} timed out after 30s`))
      }, 30_000)
    })
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return p
  }

  private notify(method: string, params: unknown) {
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /**
   * Call a Grip tool and return its parsed JSON payload.
   * Grip tools return a single text content block containing JSON.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.request('tools/call', { name, arguments: args }) as {
      isError?: boolean
      content?: Array<{ type: string; text?: string }>
    }
    const text = result.content?.find((c) => c.type === 'text')?.text ?? ''
    if (result.isError) throw new Error(`grip tool ${name} failed: ${text}`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  close() {
    this.socket?.end()
    this.socket?.destroy()
  }
}

/**
 * Connect, target the given Figma file (must have the Grip plugin open),
 * run `fn`, and always close the session.
 */
export async function withGrip<T>(fileKey: string, fn: (grip: GripClient) => Promise<T>): Promise<T> {
  const grip = new GripClient()
  await grip.connect()
  try {
    const health = await grip.callTool('grip_health') as {
      plugins: Array<{ fileKey: string; fileName: string }>
    }
    if (!health.plugins?.some((p) => p.fileKey === fileKey)) {
      const open = health.plugins?.map((p) => `${p.fileName} (${p.fileKey})`).join(', ') || 'none'
      throw new Error(`Grip plugin not connected to file ${fileKey}. Connected: ${open}`)
    }
    await grip.callTool('set_active_file', { target: fileKey })
    return await fn(grip)
  } finally {
    grip.close()
  }
}
