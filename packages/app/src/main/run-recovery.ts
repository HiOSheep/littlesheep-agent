// Deferred startup recovery of interrupted runs, leases and checkpoints.
//
// The send control is disabled until `/runtime/readiness` reports `ready`, and the
// publish happens in `main/index.ts` right after `server.setRunner(created)`.
// Recovery of *previous* work used to run inside that publish, so a large data
// root pushed the moment a user could type behind work that has nothing to do
// with the message they are waiting to send: measured on the large-root fixture,
// `execution-ready` was 10.0 s cold and 2.7 s warm against 0.05 s on a small root.
//
// What moved, and what deliberately did not:
//
//   * Active-run recovery (`recoverDurableRuns('queue')`), the interrupted-resume
//     release and the completed-run reconciliation now start here, after the
//     Runner is published. `RunRouter` awaits `done()` on every request that
//     names a session, so a run that continues a recovered conversation never
//     starts before its own recovery has finished.
//   * The event-only compatibility scan for runs that predate the lease store
//     still runs after the queue pass and is still not awaited: `recoverDurableRun`
//     re-reads the run lease and fails closed, so a run started in the meantime
//     cannot be double-owned.
//   * Fresh conversations never wait. A new run cannot be one of the runs being
//     recovered (it has no history), which is what `isFreshConversation` says.
import type { AgentRunner } from '@littlesheep/runner'
import { asSessionId } from '@littlesheep/types'
import { recordBootstrapTiming } from './bootstrap-timing.js'

export interface DurableInboxRecoveryStore {
  listRecoverableRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  listActiveClaimedRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  nextClaimLeaseExpiry?: () => Promise<string | undefined>
}

export interface DurableRunLeaseRecoveryStore {
  read?: (sessionId: string, runId: string) => Promise<unknown | null>
  listActiveRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  listRecoverableRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  nextLeaseExpiry?: () => Promise<string | undefined>
}

export interface DurableRecoveryInfrastructure {
  durableRunLeaseStore?: DurableRunLeaseRecoveryStore
}

/** Sessions this pass recovered a run for. */
export type RecoveredSessionIds = ReadonlySet<string>

export interface DeferredRunRecoveryOptions {
  /**
   * Whether a resume run belongs to *this* process right now.
   *
   * `recoverInterruptedResumes` releases resume leases left by a dead process.
   * It cannot tell such a lease from one this process started a moment ago, and
   * the two are now concurrent: recovery no longer finishes before the routes
   * answer, so a checkpoint the user just resumed could be released as if it had
   * been abandoned. The composition root answers this from its live run
   * registry, and a run that is active here is left alone.
   */
  isRunActive?: (runId: string) => boolean
}

export class DeferredRunRecovery {
  /** Resolves when the recovery a starting run could depend on has settled. */
  private readonly settled: Promise<RecoveredSessionIds>
  private durableRecoveryTimer: NodeJS.Timeout | undefined
  private stopped = false

  private constructor(
    private readonly runner: AgentRunner,
    private readonly options: DeferredRunRecoveryOptions,
  ) {
    this.settled = this.run()
    // A failed pass is reported by `run` itself; this only keeps an unobserved
    // rejection from surfacing as an unhandled one.
    this.settled.catch(() => undefined)
  }

  /**
   * Begin recovery for a Runner the composition root has just built.
   *
   * The returned object is usable immediately; `done` is what gates the routes
   * that need recovery. A failure is logged and never rejects: a run must not
   * fail because recovering a *different* run did.
   */
  static start(runner: AgentRunner, options: DeferredRunRecoveryOptions = {}): DeferredRunRecovery {
    return new DeferredRunRecovery(runner, options)
  }

  /** Resolves once the recovery a starting run could depend on has settled. */
  done(): Promise<RecoveredSessionIds> {
    return this.settled
  }

  /**
   * Await recovery only when the request could have work in it.
   *
   * A brand-new conversation has no session id, so it never waits; every other
   * run observes recovery before it starts. The check is on the session, not on
   * "did this pass find anything", so a request that arrives after the pass
   * finished also sees a settled promise.
   */
  async waitIfNeeded(sessionId: string | undefined): Promise<void> {
    if (isFreshConversation(sessionId)) return
    await this.settled
  }

  /**
   * Stop this pass and its wake-up.
   *
   * A Runner rebuild replaces the router that owns this object: the new Runner
   * starts its own pass over the same data root, so leaving this timer armed
   * would run the same recovery twice. An in-flight pass finishes on its own and
   * only skips scheduling.
   */
  stop(): void {
    this.stopped = true
    if (this.durableRecoveryTimer) clearTimeout(this.durableRecoveryTimer)
    this.durableRecoveryTimer = undefined
  }

  private async run(): Promise<RecoveredSessionIds> {
    const recovered = new Set<string>()
    let stageStartedAt = recordBootstrapTiming('run-recovery-start')
    const pass = this.durableRunLeaseStore() ? 'queue' : 'all'
    try {
      await this.recover(pass, recovered)
      stageStartedAt = recordBootstrapTiming('run-recovery-runs-ready', stageStartedAt)
    } catch (error) {
      // Discovery itself failed. Individual run failures are handled inside
      // `recover` so one corrupt run cannot stop the others.
      console.error(`[durable-harness] run recovery discovery failed: ${errorMessage(error)}`)
      stageStartedAt = recordBootstrapTiming('run-recovery-runs-ready', stageStartedAt)
    }
    if (pass === 'queue') {
      // Compatibility pass for runs that predate the lease store. Not awaited:
      // the queue pass above is what admission depends on, and the lease check
      // inside `recover` keeps this pass from re-driving a live run.
      void this.recover('events', new Set()).catch((error: unknown) => {
        console.error(`[durable-harness] event compatibility recovery failed: ${errorMessage(error)}`)
      })
    }
    try {
      const released = await this.recoverInterruptedResumes()
      if (released > 0) console.info(`[run-checkpoints] released ${released} interrupted resume lease(s)`)
    } catch (error) {
      console.error(`[run-checkpoints] startup lease recovery failed: ${errorMessage(error)}`)
    }
    stageStartedAt = recordBootstrapTiming('run-recovery-resumes-ready', stageStartedAt)
    try {
      const reconciled = await this.runner.runCheckpoints?.reconcileCompletedRuns(
        'startup reconciled checkpoint with successful execution log',
      ) ?? 0
      if (reconciled > 0) console.info(`[run-checkpoints] sealed ${reconciled} checkpoint(s) from successful execution logs`)
    } catch (error) {
      console.error(`[run-checkpoints] startup completion reconciliation failed: ${errorMessage(error)}`)
    }
    recordBootstrapTiming('run-recovery-ready', stageStartedAt)
    if (!this.stopped) {
      try {
        await this.scheduleWakeUp()
      } catch (error) {
        console.error(`[durable-harness] recovery wake-up scheduling failed: ${errorMessage(error)}`)
      }
    }
    return recovered
  }

  /**
   * Find and recover runs that a previous process left behind.
   *
   * `source` selects the discovery sources: the lease/inbox pair is the modern
   * one, the event partitions are the compatibility one. `collected` receives the
   * sessions whose runs were recovered.
   */
  private async recover(source: 'all' | 'queue' | 'events', collected: Set<string>): Promise<void> {
    if (this.stopped) return
    const durableEventStore = this.runner.infra?.durableEventStore
    const durableInboxStore = this.runner.infra?.durableInboxStore as unknown as DurableInboxRecoveryStore | undefined
    const durableRunLeaseStore = this.durableRunLeaseStore()
    if (!((source !== 'queue' && durableEventStore?.listRuns)
      || (source !== 'events' && durableInboxStore?.listRecoverableRuns)
      || (source !== 'events' && durableRunLeaseStore?.listRecoverableRuns))
      || !this.runner.recoverDurableRun) {
      return
    }
    const activeClaimedRuns = new Set([
      ...(await durableInboxStore?.listActiveClaimedRuns?.() ?? []),
      ...(await durableRunLeaseStore?.listActiveRuns?.() ?? []),
    ].map((run) => `${run.sessionId}\0${run.runId}`))
    const discoveredRuns = [
      ...(source !== 'queue'
        ? (await durableEventStore?.listRuns?.() ?? []).filter(
            (run) => !activeClaimedRuns.has(`${run.sessionId}\0${run.runId}`),
          )
        : []),
      ...(source !== 'events' ? await durableInboxStore?.listRecoverableRuns?.() ?? [] : []),
      ...(source !== 'events' ? await durableRunLeaseStore?.listRecoverableRuns?.() ?? [] : []),
    ]
    const durableRuns = [...new Map(discoveredRuns.map((run) => (
      [`${run.sessionId}\0${run.runId}`, run] as const
    ))).values()].sort((left, right) => (
      left.sessionId.localeCompare(right.sessionId) || left.runId.localeCompare(right.runId)
    ))
    for (const durableRun of durableRuns) {
      if (this.stopped) break
      try {
        // Modern event-backed runs also have a lease. The queue pass has already
        // handled expired leases; an active or released lease must never be
        // re-driven by the legacy compatibility scan.
        if (source === 'events' && durableRunLeaseStore?.read
          && await durableRunLeaseStore.read(durableRun.sessionId, durableRun.runId)) continue
        const recovery = await this.runner.recoverDurableRun(
          asSessionId(durableRun.sessionId),
          durableRun.runId,
        )
        collected.add(durableRun.sessionId)
        if (recovery.actions.length > 0) {
          console.info(`[durable-harness] recovered ${durableRun.runId}: ${recovery.actions.map((action) => action.kind).join(', ')}`)
        }
      } catch (error) {
        // A corrupt or concurrently-owned run must remain visible for a later
        // operator decision; startup of the Local API still proceeds.
        console.error(`[durable-harness] recovery failed for ${durableRun.runId}: ${errorMessage(error)}`)
      }
    }
  }

  /**
   * Release resume leases a dead process left behind.
   *
   * `recoverInterruptedResumes` has no notion of "this process", so recovery is
   * asked not to release a resume run that is live here: during a real restart
   * no run is live and every lease is released as before, while a checkpoint the
   * user resumed after the Runner was published is left running. Without that
   * check the deferred pass would interrupt the very resume it was published to
   * make possible - measured as a disposition flipping from `resumed` to
   * `interrupted` in `run-checkpoint-api.test.ts`.
   */
  private async recoverInterruptedResumes(): Promise<number> {
    const control = this.runner.runCheckpoints
    if (!control?.recoverInterruptedResumes) return 0
    const isRunActive = this.options.isRunActive
    if (!isRunActive) {
      return control.recoverInterruptedResumes(
        'application restarted before checkpoint continuation completed',
      )
    }
    // A run registered while this call is in flight must also be spared, so the
    // check is made per disposition rather than once for the batch.
    return control.recoverInterruptedResumes(
      'application restarted before checkpoint continuation completed',
      { isRunActive },
    )
  }

  /** One wake-up at the earliest claim/lease expiry instead of polling. */
  private async scheduleWakeUp(): Promise<void> {
    if (this.stopped) return
    if (this.durableRecoveryTimer) clearTimeout(this.durableRecoveryTimer)
    this.durableRecoveryTimer = undefined
    const durableInboxStore = this.runner.infra?.durableInboxStore as unknown as DurableInboxRecoveryStore | undefined
    const durableRunLeaseStore = this.durableRunLeaseStore()
    const expiries = [
      await durableInboxStore?.nextClaimLeaseExpiry?.(),
      await durableRunLeaseStore?.nextLeaseExpiry?.(),
    ].filter((value): value is string => Boolean(value)).sort()
    const expiresAt = expiries[0]
    if (!expiresAt || this.stopped) return
    const delayMs = Math.max(0, Date.parse(expiresAt) - Date.now())
    this.durableRecoveryTimer = setTimeout(() => {
      this.durableRecoveryTimer = undefined
      void this.recover('queue', new Set()).catch((error: unknown) => {
        console.error(`[durable-harness] scheduled recovery failed: ${errorMessage(error)}`)
      })
    }, delayMs)
    this.durableRecoveryTimer.unref?.()
  }

  private durableRunLeaseStore(): DurableRunLeaseRecoveryStore | undefined {
    return (this.runner.infra as unknown as DurableRecoveryInfrastructure | undefined)?.durableRunLeaseStore
  }
}

/**
 * Whether a run for this request can be proved to have no history to recover.
 *
 * The rule is deliberately about the request: a run with no session id is the
 * first turn of a conversation that does not exist yet, so no checkpoint, lease,
 * inbox command or event partition can name it. Any request that carries a
 * session id is a candidate for recovery and waits, because the app generates a
 * session id before the first turn is written and a retired id is not reused.
 */
export function isFreshConversation(sessionId: string | undefined): boolean {
  return sessionId === undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
