// Shared HTTP primitives for Local App API domain routers.

import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_JSON_BODY_BYTES = 1024 * 1024

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

export function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
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
