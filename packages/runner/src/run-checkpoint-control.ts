// Bounded application-facing control surface for durable run checkpoints.

import type { RunCheckpointDispositionOutcome } from './run-checkpoint-disposition-store.js'
import type { RunCheckpointInspection, RunCheckpointController } from './run-checkpoint-controller.js'
import type { RunCheckpointStore, RunCheckpointStoreDiagnostics } from './run-checkpoint-store.js'
import type { ExecutionLogStore } from './execution-log.js'

export interface RunCheckpointControl {
  list(limit?: number): Promise<RunCheckpointInspection[]>
  inspect(checkpointId: string): Promise<RunCheckpointInspection | null>
  abandon(checkpointId: string, reason: string): Promise<RunCheckpointDispositionOutcome>
  /** Reconcile successful execution logs with intermediate checkpoints left by older builds or crashes. */
  reconcileCompletedRuns(reason: string): Promise<number>
  /** Convert process-local resume leases into auditable, resumable interruptions. */
  recoverInterruptedResumes(reason: string): Promise<number>
  diagnostics(): RunCheckpointStoreDiagnostics
}

export function createRunCheckpointControl(
  controller: RunCheckpointController | undefined,
  checkpointStore: Pick<RunCheckpointStore, 'diagnostics'> | undefined,
  executionLogStore: Pick<ExecutionLogStore, 'read'> | undefined,
  expectedModel: string,
): RunCheckpointControl | undefined {
  if (!controller || !checkpointStore) return undefined
  return {
    list: (limit) => controller.list(limit, expectedModel),
    inspect: (checkpointId) => controller.inspect(checkpointId, expectedModel),
    abandon: (checkpointId, reason) => controller.abandon(checkpointId, reason),
    reconcileCompletedRuns: async (reason) => {
      if (!executionLogStore) return 0
      const inspections = await controller.list(128)
      const sourceRunIds = [...new Set(inspections.map((inspection) => String(inspection.checkpoint.runId)))]
      let reconciled = 0
      for (const sourceRunId of sourceRunIds) {
        const log = await executionLogStore.read(sourceRunId)
        if (log?.status !== 'ok' || !log.runCheckpointId) continue
        const checkpoint = await controller.inspect(log.runCheckpointId)
        if (!checkpoint || String(checkpoint.checkpoint.runId) !== sourceRunId) continue
        const outcome = await controller.completeSourceRun(log.runCheckpointId, sourceRunId, reason)
        if (outcome.kind === 'written') reconciled += 1
      }
      return reconciled
    },
    recoverInterruptedResumes: async (reason) => {
      const inspections = await controller.list(128, expectedModel)
      let recovered = 0
      for (const inspection of inspections) {
        const disposition = inspection.disposition
        if (disposition?.status !== 'resuming' || !disposition.resumeRunId) continue
        const outcome = await controller.interruptResume(
          inspection.checkpoint.id,
          disposition.resumeRunId,
          reason,
        )
        if (outcome.kind !== 'conflict') recovered += 1
      }
      return recovered
    },
    diagnostics: () => checkpointStore.diagnostics(),
  }
}
