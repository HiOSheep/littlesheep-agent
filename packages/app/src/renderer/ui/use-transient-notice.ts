// A transient confirmation that clears itself, and the rule that keeps it safe.
//
// Settings pages report "已保存供应商 opencode。" after a successful action. Those
// lines used to sit in the page flow and stay there until something replaced them,
// which meant a stale success message stayed on screen while the user moved on, and
// the line pushed the content below it down and back again.
//
// The rule that matters: ONLY a confirmation auto-hides. An error never does. A
// failure that vanishes after three seconds is a failure the user can miss entirely,
// and several of these pages render the same slot for both — so the tone decides,
// not the call site.
//
// The scheduling itself lives in `transient-notice-timer.ts` as a pure object, so the
// rules can be tested without a DOM: this repository's vitest runs in a node
// environment with no DOM testing library, and a React hook cannot be mounted there.
// This file holds only the binding to React state.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Feedback } from './feedback'
import { createTransientTimer } from './transient-notice-timer'

/** How long a confirmation stays before it clears itself. */
export const TRANSIENT_NOTICE_MS = 3_000

export interface TransientNotice {
  /** The confirmation to show, or null when there is none. */
  notice: Feedback | null
  /** Replace the confirmation; an identical message restarts its timer. */
  show: (message: string, detail?: unknown) => void
  /** Clear it early (a new action started, or the user dismissed it). */
  clear: () => void
  /** True while a confirmation is on screen, so a surface can decide to animate. */
  visible: boolean
}

/**
 * Show a success message for {@link TRANSIENT_NOTICE_MS}, then clear it.
 *
 * Repeating the SAME message restarts the timer rather than being ignored: pressing
 * save twice should keep the confirmation visible the second time, not leave a
 * message that expires from the first press while the second one goes unacknowledged.
 */
export function useTransientNotice(durationMs = TRANSIENT_NOTICE_MS): TransientNotice {
  const [notice, setNotice] = useState<Feedback | null>(null)
  // One timer per message identity, so a replaced message cannot be cleared by the
  // previous message's deadline firing late.
  const timer = useMemo(
    () => createTransientTimer<Feedback>({
      durationMs,
      schedule: (callback, ms) => window.setTimeout(callback, ms),
      cancel: (handle) => window.clearTimeout(handle),
      publish: setNotice,
    }),
    [durationMs],
  )

  const clear = useCallback(() => timer.clear(), [timer])

  const show = useCallback((message: string, detail?: unknown) => {
    timer.show({ tone: 'success', message, detail: detail === undefined ? null : String(detail) })
  }, [timer])

  // A page can unmount with a timer pending — navigating away mid-confirmation is
  // normal — so the timer must not outlive the component that owns it.
  const dispose = useRef(timer.dispose)
  dispose.current = timer.dispose
  useEffect(() => () => dispose.current(), [])

  return { notice, show, clear, visible: notice !== null }
}
