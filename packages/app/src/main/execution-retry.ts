// Bounded retry for the execution stage of the bootstrap.
//
// A start that fails after the window is already usable (stage 3) leaves a shell
// that states the reason and waits: the user can fix the configuration in
// settings, and this is what lets them try again without restarting the app. It
// is bounded on purpose - the retry runs real startup work, so an exhausted
// budget has to end in a state the user can act on rather than a loop.

export const MAX_EXECUTION_RETRY_ATTEMPTS = 3

export interface ExecutionRetryOutcome {
  /** False when a retry is already running or the budget is spent. */
  accepted: boolean
  /** Attempts used *including* this one. */
  attemptsUsed: number
  attemptsRemaining: number
  /** Why the attempt was refused, when it was. */
  refusedBecause?: 'in-flight' | 'exhausted'
  /** Failure text of this attempt, when it failed. */
  reason?: string
}

export interface ExecutionRetryController {
  retry(): Promise<ExecutionRetryOutcome>
  attemptsUsed(): number
  attemptsRemaining(): number
}

export interface ExecutionRetryOptions {
  /** Re-reads the configuration and runs stage 3; rejects when that fails. */
  attempt: () => Promise<void>
  /** Called before each attempt so the window leaves the failed state. */
  onBegin: () => void
  /** Called when an attempt fails, with whether another one is still allowed. */
  onFailure: (message: string, retryable: boolean) => void
  maxAttempts?: number
  log?: (message: string) => void
}

export function createExecutionRetryController(options: ExecutionRetryOptions): ExecutionRetryController {
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_EXECUTION_RETRY_ATTEMPTS)
  let used = 0
  let inFlight: Promise<ExecutionRetryOutcome> | undefined

  const remaining = () => Math.max(0, maxAttempts - used)

  async function run(): Promise<ExecutionRetryOutcome> {
    used += 1
    options.onBegin()
    try {
      await options.attempt()
      // A success ends this failure episode: the budget bounds *consecutive*
      // failed tries, so a later, unrelated failure still gets its own attempts.
      used = 0
      options.log?.(`execution retry ${used + 1}/${maxAttempts} succeeded`)
      return { accepted: true, attemptsUsed: used, attemptsRemaining: remaining() }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Another retry is only offered while the budget lasts: after that the
      // caller has to change something outside the app (or restart it).
      options.onFailure(reason, remaining() > 0)
      options.log?.(`execution retry ${used}/${maxAttempts} failed: ${reason}`)
      return { accepted: true, attemptsUsed: used, attemptsRemaining: remaining(), reason }
    }
  }

  return {
    retry(): Promise<ExecutionRetryOutcome> {
      if (inFlight) {
        return Promise.resolve({
          accepted: false,
          attemptsUsed: used,
          attemptsRemaining: remaining(),
          refusedBecause: 'in-flight',
        })
      }
      if (remaining() === 0) {
        return Promise.resolve({
          accepted: false,
          attemptsUsed: used,
          attemptsRemaining: 0,
          refusedBecause: 'exhausted',
        })
      }
      inFlight = run().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    attemptsUsed: () => used,
    attemptsRemaining: remaining,
  }
}
