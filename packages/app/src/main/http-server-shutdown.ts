import type { Server } from 'node:http'

export interface HttpServerShutdownOptions {
  forceAfterMs?: number
}

/** Stops accepting requests, then tears down connections that outlive the grace period. */
export function closeHttpServer(
  server: Server,
  options: HttpServerShutdownOptions = {},
): Promise<void> {
  const forceAfterMs = Math.max(0, options.forceAfterMs ?? 750)

  return new Promise((resolve) => {
    let settled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined

    const settle = () => {
      if (settled) return
      settled = true
      if (forceTimer) clearTimeout(forceTimer)
      resolve()
    }

    forceTimer = setTimeout(() => {
      server.closeAllConnections()
      settle()
    }, forceAfterMs)
    forceTimer.unref?.()

    try {
      server.close(() => settle())
      server.closeIdleConnections()
    } catch {
      settle()
    }
  })
}
