// IPC channel names for the desktop readiness and cold-start timing bridge.
//
// The channel names live in `shared/` so preload and Main cannot drift. The
// payload types live with the contracts they belong to
// (`runtime-readiness-contracts.ts`).

/** Main → Renderer: execution-readiness transitions and the current snapshot. */
export const RUNTIME_READINESS_CHANNEL = 'littlesheep:runtime-readiness'

/** Renderer → Main: one startup timing mark (stage name + renderer duration). */
export const RENDERER_TIMING_CHANNEL = 'littlesheep:renderer-timing'

/** Renderer → Main: ask for the current readiness snapshot (missed-notice repair). */
export const RUNTIME_READINESS_QUERY_CHANNEL = 'littlesheep:runtime-readiness-query'

/**
 * Renderer → Main: retry the execution stage after a failure the user fixed.
 *
 * Answers with `{ accepted, attemptsUsed, attemptsRemaining, refusedBecause?, reason? }`;
 * a refused call means another attempt is in flight or the bounded budget is
 * spent, and the window must not present it as a new attempt.
 */
export const RUNTIME_RETRY_EXECUTION_CHANNEL = 'littlesheep:runtime-retry-execution'

/**
 * Timing stages the Renderer may report. Closed on purpose: bootstrap timing is
 * a diagnostic surface and must not become an arbitrary log channel.
 */
export const RENDERER_TIMING_STAGES = [
  'renderer-first-frame',
] as const

export type RendererTimingStage = typeof RENDERER_TIMING_STAGES[number]

/** Upper bound accepted from the renderer; anything larger is a bug, not a fact. */
export const RENDERER_TIMING_MAX_MS = 600_000

export function isRendererTimingStage(value: unknown): value is RendererTimingStage {
  return typeof value === 'string' && (RENDERER_TIMING_STAGES as readonly string[]).includes(value)
}

export function isRendererTimingDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= RENDERER_TIMING_MAX_MS
}
