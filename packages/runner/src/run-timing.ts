// Opt-in per-run timing: `LITTLESHEEP_BOOTSTRAP_TIMING=1`.
//
// The cold-start ledger explains how long the app takes to become executable, and stops there: nothing
// measured how long a message takes from "sent" to "first token", which is what the user actually waits
// for. These marks close that gap, with the same shape as the composition root's entries — a stage name,
// milliseconds, and the offset from the start of the run. No user text, no argument values, no paths.

const enabled = process.env['LITTLESHEEP_BOOTSTRAP_TIMING'] === '1'

export interface RunTiming {
  /** Emit one stage. `explicitDurationMs` is for work measured by the caller (overlapping stages). */
  mark: (stage: string, explicitDurationMs?: number) => void
  /** Emit `first-token` once per run: the moment the user actually starts seeing an answer. */
  markFirstToken: () => void
  /** Milliseconds since this timing was created. */
  elapsedMs: () => number
}

export function createRunTiming(scope: string): RunTiming {
  const startedAt = performance.now()
  let markAt = startedAt
  let firstTokenMarked = false
  const emit = (stage: string, explicitDurationMs?: number): void => {
    const now = performance.now()
    if (enabled) {
      console.log(`[run-timing] ${JSON.stringify({
        scope,
        stage,
        sinceRunStartMs: Math.round((now - startedAt) * 10) / 10,
        durationMs: Math.round((explicitDurationMs ?? (now - markAt)) * 10) / 10,
      })}`)
    }
    markAt = now
  }
  return {
    mark: emit,
    markFirstToken: () => {
      if (firstTokenMarked) return
      firstTokenMarked = true
      emit('first-token')
    },
    elapsedMs: () => performance.now() - startedAt,
  }
}

/**
 * The timing of the run currently in flight.
 *
 * One runner process serves one run at a time (runs are serialized per session), so a module-level handle
 * is enough and keeps the marks out of every function signature. Before the first run it is an idle
 * instance whose marks only advance a timer nobody reads.
 */
let currentRunTiming: RunTiming = createRunTiming('idle')

export function beginRunTiming(): RunTiming {
  currentRunTiming = createRunTiming('run')
  return currentRunTiming
}

/** Mark a stage of the run in flight; safe to call before any run started. */
export function markRun(stage: string, explicitDurationMs?: number): void {
  currentRunTiming.mark(stage, explicitDurationMs)
}

/** Mark the first streamed token of the run in flight. */
export function markRunFirstToken(): void {
  currentRunTiming.markFirstToken()
}
