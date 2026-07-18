// Display-synchronised frame gate for short-lived renderer updates.
//
// A gate coalesces invalidations into one requestAnimationFrame callback. The
// browser supplies the callback timestamp from the active compositor VSync;
// callers must not replace it with a timer or a fixed frame loop.

export type DisplayFrameCallback = (timestamp: number) => void
export type DisplayFrameRequest = (callback: DisplayFrameCallback) => number
export type DisplayFrameCancel = (handle: number) => void

export interface DisplayFrameGate {
  request(callback: DisplayFrameCallback): void
  cancel(): void
  readonly pending: boolean
}

export function createDisplayFrameGate(
  requestFrame: DisplayFrameRequest,
  cancelFrame: DisplayFrameCancel,
): DisplayFrameGate {
  let handle: number | undefined

  return {
    request(callback) {
      if (handle !== undefined) return
      handle = requestFrame((timestamp) => {
        handle = undefined
        callback(timestamp)
      })
    },
    cancel() {
      if (handle === undefined) return
      cancelFrame(handle)
      handle = undefined
    },
    get pending() {
      return handle !== undefined
    },
  }
}

export function createWindowDisplayFrameGate(): DisplayFrameGate {
  return createDisplayFrameGate(
    (callback) => window.requestAnimationFrame(callback),
    (handle) => window.cancelAnimationFrame(handle),
  )
}
