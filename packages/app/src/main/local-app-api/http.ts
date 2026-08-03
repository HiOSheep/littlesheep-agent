// Shared HTTP primitives for Local App API domain routers.

import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_JSON_BODY_BYTES = 1024 * 1024
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000
export const MAX_SSE_BUFFERED_BYTES = 512 * 1024

export interface LocalAppApiRequest {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  path: string
  method: string
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function openSse(
  res: ServerResponse,
  heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS,
): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    res.removeListener('close', cleanup)
    res.removeListener('finish', cleanup)
  }
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      cleanup()
      return
    }
    if (!writeSseChunk(res, ': heartbeat\n\n')) cleanup()
  }, Math.max(1_000, Math.min(60_000, heartbeatIntervalMs)))
  timer.unref?.()
  res.once('close', cleanup)
  res.once('finish', cleanup)
  return cleanup
}

export function writeSse(res: ServerResponse, event: string, data: unknown): boolean {
  return writeSseChunk(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function writeSseChunk(res: ServerResponse, chunk: string): boolean {
  if (res.destroyed || res.writableEnded) return false
  const writableLength = Number.isFinite(res.writableLength) ? res.writableLength : 0
  if (writableLength + Buffer.byteLength(chunk, 'utf8') > MAX_SSE_BUFFERED_BYTES) {
    res.destroy()
    return false
  }
  res.write(chunk)
  return true
}

export function readJson(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
      req.destroy()
    }
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        fail(new HttpError(413, 'request body too large'))
        return
      }
      data += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}
