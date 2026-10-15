// The scheduling rules behind a self-clearing confirmation, with no React and no DOM.
//
// Kept separate from the hook because these rules are where the bugs live — a stale
// message surviving its replacement, a repeat being ignored, a timer outliving its
// owner — and this repository's vitest runs in a node environment with no DOM testing
// library, so a hook cannot be mounted. The hook is then a thin binding.

/** How a timer is started and stopped; injected so tests control time. */
export interface TimerHost<T> {
  durationMs: number
  schedule: (callback: () => void, ms: number) => number
  cancel: (handle: number) => void
  /** Receives the current value: the confirmation, or null once it expires. */
  publish: (value: T | null) => void
}

export interface TransientTimer<T> {
  /** Replace the value and (re)start the deadline; an identical value restarts it. */
  show: (value: T) => void
  /** Clear the value now and cancel the pending deadline. */
  clear: () => void
  /** Cancel without publishing — for unmount, where the owner is going away. */
  dispose: () => void
}

/**
 * A value that publishes itself, then publishes null after `durationMs`.
 *
 * Every decision here exists because of a specific failure mode:
 *
 *   - Each deadline carries the sequence number it was created for. Without that, a
 *     message shown at t=0 whose deadline fires at t=3000 clears the message shown at
 *     t=2900. The user would see the second confirmation vanish almost immediately.
 *   - `show` always restarts the deadline, even for an identical message. Ignoring the
 *     repeat would let the timer created by the first press expire while the second
 *     press went unacknowledged.
 *   - `clear` and `dispose` cancel first. A surviving timer fires into whatever
 *     message comes next, or into a component that no longer exists.
 */
export function createTransientTimer<T>(host: TimerHost<T>): TransientTimer<T> {
  let handle: number | null = null
  let sequence = 0

  const cancel = () => {
    if (handle !== null) {
      host.cancel(handle)
      handle = null
    }
  }

  const show = (value: T) => {
    cancel()
    const mine = sequence + 1
    sequence = mine
    host.publish(value)
    handle = host.schedule(() => {
      handle = null
      // A newer message owns the screen now; this deadline belongs to an older one.
      if (sequence !== mine) return
      host.publish(null)
    }, host.durationMs)
  }

  const clear = () => {
    cancel()
    sequence += 1
    host.publish(null)
  }

  return { show, clear, dispose: cancel }
}
