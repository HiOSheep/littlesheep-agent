/**
 * Wait for a bounded delay while removing the AbortSignal listener on every
 * completion path. Channel reconnect loops call this repeatedly, so leaving
 * the listener attached after a normal delay would grow the signal's listener
 * set for the lifetime of the channel.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => finish()

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      finish()
      return
    }
    timer = setTimeout(finish, Math.max(0, ms))
  })
}
