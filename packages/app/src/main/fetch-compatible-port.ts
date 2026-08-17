// Keep aligned with the Fetch Standard's port-blocking table used by Chromium and Node fetch.
const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
])

const DEFAULT_BIND_ATTEMPTS = 8

export interface LoopbackPortBinder {
  bind(requestedPort: number): Promise<number>
  release(): Promise<void>
}

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port)
}

export async function bindFetchCompatiblePort(
  requestedPort: number,
  binder: LoopbackPortBinder,
  maxAttempts = DEFAULT_BIND_ATTEMPTS,
): Promise<number> {
  const boundedMaxAttempts = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.floor(maxAttempts))
    : DEFAULT_BIND_ATTEMPTS
  const attemptLimit = requestedPort === 0
    ? boundedMaxAttempts
    : 1

  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    const boundPort = await binder.bind(requestedPort)
    if (requestedPort !== 0 || !isFetchBlockedPort(boundPort)) return boundPort
    await binder.release()
  }

  throw new Error(`could not bind a Fetch-compatible loopback port after ${attemptLimit} attempts`)
}

export function bindFetchCompatibleHttpServer(server: Server, requestedPort: number): Promise<number> {
  return bindFetchCompatiblePort(requestedPort, {
    bind: (port) => listenOnLoopback(server, port),
    release: () => closeHttpServer(server, { forceAfterMs: 0 }),
  })
}

function listenOnLoopback(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        resolve(addr.port)
      } else {
        reject(new Error('HTTP server did not expose a TCP port'))
      }
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}
import type { Server } from 'node:http'
import { closeHttpServer } from './http-server-shutdown.js'
