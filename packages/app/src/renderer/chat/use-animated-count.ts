// Counts that walk to their new value instead of jumping to it.
//
// The transcript's line counts change while a file is being written, and a number that teleports
// reads as noise: the eye cannot tell whether it grew by three or by thirty. Stepping to the new
// value over a short window keeps the change legible, and a reader who prefers no motion gets the
// value immediately.
import { useEffect, useRef, useState } from 'react'

export const LINE_COUNT_MOTION_MS = 260

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Eases `value` from whatever it was to what it is now. The first value is shown as-is: nothing was
 * on screen before it, so there is no change to make legible.
 */
export function useAnimatedCount(value: number | null, durationMs = LINE_COUNT_MOTION_MS): number | null {
  const [display, setDisplay] = useState(value)
  const fromRef = useRef(value)
  const frameRef = useRef<number>()
  const startedAtRef = useRef(0)

  useEffect(() => {
    const from = fromRef.current
    if (value === null || from === null || from === value || durationMs <= 0 || prefersReducedMotion()) {
      fromRef.current = value
      setDisplay(value)
      return
    }
    startedAtRef.current = performance.now()
    const step = () => {
      const elapsed = performance.now() - startedAtRef.current
      const progress = Math.min(1, elapsed / durationMs)
      // Ease out: fast at first, settling on the real number.
      const eased = 1 - (1 - progress) * (1 - progress)
      const next = Math.round(from + (value - from) * eased)
      setDisplay(next)
      if (progress < 1) frameRef.current = window.requestAnimationFrame(step)
      else fromRef.current = value
    }
    frameRef.current = window.requestAnimationFrame(step)
    return () => {
      if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
    }
  }, [durationMs, value])

  useEffect(() => () => {
    if (frameRef.current !== undefined) window.cancelAnimationFrame(frameRef.current)
  }, [])

  return display
}
