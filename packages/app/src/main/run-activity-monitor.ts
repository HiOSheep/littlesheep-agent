import type { AgentRunner } from '@littlesheep/runner'
import type {
  RuntimeActiveRunAction,
  RuntimeActiveRunActionOutcome,
  RuntimeActiveRunControl,
  RuntimeActiveRunSnapshot,
} from '@littlesheep/types'

const MAX_ACTIVITY_SOURCES = 8
const MAX_ACTIVITY_LISTENERS = 16
const MAX_AGGREGATED_ACTIVE_RUNS = 128

export interface RunActivityMonitorDiagnostics {
  sourceCount: number
  listenerCount: number
  activeRunCount: number
}

/** Aggregates current and draining Runner instances without making Renderer state authoritative. */
export class RunActivityMonitor {
  private readonly sources = new Map<RuntimeActiveRunControl, () => void>()
  private readonly listeners = new Set<(runs: RuntimeActiveRunSnapshot[]) => void>()
  private disposed = false

  setRunners(runners: readonly (AgentRunner | null | undefined)[]): void {
    if (this.disposed) return
    const desired = [...new Set(runners
      .map((runner) => runner?.activeRuns)
      .filter((control): control is RuntimeActiveRunControl => Boolean(control)))]
      .slice(0, MAX_ACTIVITY_SOURCES)

    for (const [source, unsubscribe] of [...this.sources.entries()]) {
      if (desired.includes(source)) continue
      unsubscribe()
      this.sources.delete(source)
    }
    for (const source of desired) {
      if (this.sources.has(source)) continue
      try {
        const unsubscribe = source.subscribe(() => this.emit())
        this.sources.set(source, unsubscribe)
      } catch {
        // A Runner may finish disposal while sources are being replaced.
      }
    }
    this.emit()
  }

  snapshot(): RuntimeActiveRunSnapshot[] {
    if (this.disposed) return []
    const byRunId = new Map<string, RuntimeActiveRunSnapshot>()
    for (const source of this.sources.keys()) {
      let runs: RuntimeActiveRunSnapshot[]
      try {
        runs = source.list()
      } catch {
        continue
      }
      for (const run of runs) {
        if (byRunId.size >= MAX_AGGREGATED_ACTIVE_RUNS && !byRunId.has(run.runId)) break
        if (!byRunId.has(run.runId)) byRunId.set(run.runId, cloneRun(run))
      }
    }
    return [...byRunId.values()]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId))
  }

  diagnostics(): RunActivityMonitorDiagnostics {
    return {
      sourceCount: this.disposed ? 0 : this.sources.size,
      listenerCount: this.disposed ? 0 : this.listeners.size,
      activeRunCount: this.snapshot().length,
    }
  }

  request(runId: string, action: RuntimeActiveRunAction, reason?: string): RuntimeActiveRunActionOutcome {
    for (const source of this.sources.keys()) {
      let ownsRun = false
      try {
        ownsRun = source.list().some((run) => run.runId === runId)
      } catch {
        continue
      }
      if (ownsRun) return source.request(runId, action, reason)
    }
    return {
      kind: 'rejected',
      action,
      reason: 'run-not-active',
      message: `Run is not active: ${runId}`,
    }
  }

  subscribe(listener: (runs: RuntimeActiveRunSnapshot[]) => void): () => void {
    if (this.disposed) {
      listener([])
      return () => undefined
    }
    if (this.listeners.size >= MAX_ACTIVITY_LISTENERS) {
      throw new Error(`run activity monitor reached its ${MAX_ACTIVITY_LISTENERS} listener limit`)
    }
    this.listeners.add(listener)
    listener(this.snapshot())
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.sources.values()) unsubscribe()
    this.sources.clear()
    for (const listener of [...this.listeners]) {
      try {
        listener([])
      } catch {
        // Disposal cannot be blocked by an observer.
      }
    }
    this.listeners.clear()
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const runs = this.snapshot()
    for (const listener of [...this.listeners]) {
      try {
        listener(runs.map(cloneRun))
      } catch {
        // Observers cannot interfere with Runner lifecycle.
      }
    }
  }
}

function cloneRun(run: RuntimeActiveRunSnapshot): RuntimeActiveRunSnapshot {
  return {
    ...run,
    activeSteps: run.activeSteps.map((step) => ({ ...step })),
  }
}
