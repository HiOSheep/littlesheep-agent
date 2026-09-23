// IPC channel names for the desktop readiness and cold-start timing bridge.
//
// The channel names live in `shared/` so preload and Main cannot drift. The
// payload types live with the contracts they belong to
// (`runtime-readiness-contracts.ts`).

/** Main → Renderer: execution-readiness transitions and the current snapshot. */
export const RUNTIME_READINESS_CHANNEL = 'littlesheep:runtime-readiness'

/** Renderer → Main: one startup timing mark (stage name + renderer clock). */
export const RENDERER_TIMING_CHANNEL = 'littlesheep:renderer-timing'

/** Renderer → Main: ask for the current readiness snapshot (missed-notice repair). */
export const RUNTIME_READINESS_QUERY_CHANNEL = 'littlesheep:runtime-readiness-query'

/**
 * Timing stages the Renderer may report. Closed on purpose: bootstrap timing is
 * a diagnostic surface and must not become an arbitrary log channel.
 */
export const RENDERER_TIMING_STAGES = ['renderer-script-start', 'renderer-first-mount'] as const

export type RendererTimingStage = typeof RENDERER_TIMING_STAGES[number]

export function isRendererTimingStage(value: unknown): value is RendererTimingStage {
  return typeof value === 'string' && (RENDERER_TIMING_STAGES as readonly string[]).includes(value)
}
