// Renderer-side cold-start marks reported to Main when bootstrap timing is on.
//
// A debugger attached after navigation cannot read these reliably: Chromium may
// already have evicted the paint entries, which is exactly what the first
// baseline run showed. The renderer therefore observes and reports its own first
// paint, and Main turns it into a `[bootstrap-timing]` entry next to the
// main-process stages.
//
// Nothing here is recorded unless `LITTLESHEEP_BOOTSTRAP_TIMING=1` is set: Main
// prints only when the variable is on, and the bridge forwards only the closed
// stage names plus a bounded duration.

import type { RendererTimingStage } from '../../shared/runtime-readiness-ipc'

/** Script evaluation start: the reference point for renderer-reported deltas. */
const rendererStartedAt = performance.now()
let frameReported = false

/**
 * Report the first contentful paint as a delay from this script's start.
 *
 * The paint entry is read from the renderer's own timeline so an already-painted
 * frame is not lost, and a not-yet-painted frame is delivered by the observer.
 * It is never estimated with a timer.
 */
export function reportRendererFirstFrame(): void {
  if (frameReported) return
  const existing = findFirstContentfulPaint()
  if (existing !== undefined) {
    frameReported = true
    report('renderer-first-frame', existing - rendererStartedAt)
    return
  }
  if (typeof PerformanceObserver === 'undefined') return
  const observer = new PerformanceObserver((list) => {
    const entry = list.getEntries().find((item) => item.name === 'first-contentful-paint')
    if (!entry || frameReported) return
    frameReported = true
    report('renderer-first-frame', entry.startTime - rendererStartedAt)
    observer.disconnect()
  })
  try {
    observer.observe({ type: 'paint', buffered: true })
  } catch {
    observer.disconnect()
  }
}

function findFirstContentfulPaint(): number | undefined {
  const entry = performance.getEntriesByType('paint')
    .find((item) => item.name === 'first-contentful-paint')
  return entry ? entry.startTime : undefined
}

/**
 * Milliseconds since this script started evaluating.
 *
 * Every renderer-reported stage shares this reference, so marks can be compared
 * with each other without comparing clocks from different origins.
 */
export function rendererElapsedMs(): number {
  return performance.now() - rendererStartedAt
}

/** Report a closed-stage mark measured from the same reference as the first frame. */
export function reportRendererStage(stage: RendererTimingStage, elapsedMs = rendererElapsedMs()): void {
  report(stage, elapsedMs)
}

function report(stage: RendererTimingStage, durationMs: number): void {
  const bridge = window.littlesheep
  if (!bridge?.reportRendererTiming) return
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  try {
    bridge.reportRendererTiming(stage, Math.round(durationMs * 10) / 10)
  } catch {
    // Timing is a diagnostic; it must never break the visible interface.
  }
}
