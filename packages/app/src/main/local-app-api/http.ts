// Shared HTTP primitives for Local App API domain routers.

import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_JSON_BODY_BYTES = 1024 * 1024
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000
export const MAX_SSE_BUFFERED_BYTES = 512 * 1024

// A response can report a pipe failure on a later turn of the event loop,
// after the state checks in writeSseChunk have passed. Keep one error listener
// per SSE response so that late client disconnects never become uncaught Main
// process exceptions.
const sseResponseStates = new WeakMap<ServerResponse, { closed: boolean }>()

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

/**
 * A route that needs the embedded Runner was called while it is still starting.
 *
 * The Local App API listens before the Runner exists so the window can show real
 * session metadata first. Runner-backed routes must answer with this error
 * instead of dereferencing a missing Runner, and the Renderer shows the reported
 * readiness reason rather than a generic failure.
 */
export class RuntimeNotReadyError extends HttpError {
  constructor(message = 'The runtime is still starting; execution is not available yet.') {
    super(503, message)
  }
}

export function isRuntimeNotReadyError(error: unknown): error is RuntimeNotReadyError {
  return error instanceof RuntimeNotReadyError
}

/**
 * Resolve the Runner inside a route branch that needs it.
 *
 * Call it lazily, at the branch that actually uses the Runner: metadata routes
 * must keep answering while it is still undefined. Returning `undefined` from a
 * branch is always a bug, and failing closed with 503 is the only honest answer.
 */
export function resolveRunner<T>(getRunner: () => T | undefined): T {
  const runner = getRunner()
  if (!runner) throw new RuntimeNotReadyError()
  return runner
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

export function openSse(
  res: ServerResponse,
  heartbeatIntervalMs = SSE_HEARTBEAT_INTERVAL_MS,
): () => void {
  const responseState = ensureSseResponseState(res)
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
    responseState.closed = true
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
  const responseState = ensureSseResponseState(res)
  if (responseState.closed || res.destroyed || res.writableEnded) return false
  const writableLength = Number.isFinite(res.writableLength) ? res.writableLength : 0
  if (writableLength + Buffer.byteLength(chunk, 'utf8') > MAX_SSE_BUFFERED_BYTES) {
    res.destroy()
    return false
  }
  try {
    res.write(chunk)
    return true
  } catch {
    // The client may close the socket between the state check and write().
    // Treat that race as a closed observer instead of an uncaught Main error.
    responseState.closed = true
    return false
  }
}

function ensureSseResponseState(res: ServerResponse): { closed: boolean } {
  const existing = sseResponseStates.get(res)
  if (existing) return existing
  const state = { closed: false }
  const markClosed = () => {
    state.closed = true
  }
  // Deliberately retain this listener for the response lifetime. A queued
  // write can fail after close/finish, and removing the listener too early
  // would reintroduce an uncaught EventEmitter error.
  res.on('error', markClosed)
  res.once('close', markClosed)
  res.once('finish', markClosed)
  sseResponseStates.set(res, state)
  return state
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
