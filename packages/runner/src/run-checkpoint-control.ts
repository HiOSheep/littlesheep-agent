// Bounded application-facing control surface for durable run checkpoints.

import type { RunCheckpointDispositionOutcome } from './run-checkpoint-disposition-store.js'
import type { RunCheckpointInspection, RunCheckpointController } from './run-checkpoint-controller.js'
import type { RunCheckpointStore, RunCheckpointStoreDiagnostics } from './run-checkpoint-store.js'

export interface RunCheckpointControl {
  list(limit?: number): Promise<RunCheckpointInspection[]>
  inspect(checkpointId: string): Promise<RunCheckpointInspection | null>
  abandon(checkpointId: string, reason: string): Promise<RunCheckpointDispositionOutcome>
  /** Convert process-local resume leases into auditable, resumable interruptions. */
  recoverInterruptedResumes(reason: string): Promise<number>
  diagnostics(): RunCheckpointStoreDiagnostics
}

export function createRunCheckpointControl(
  controller: RunCheckpointController | undefined,
  checkpointStore: Pick<RunCheckpointStore, 'diagnostics'> | undefined,
  expectedModel: string,
): RunCheckpointControl | undefined {
  if (!controller || !checkpointStore) return undefined
  return {
    list: (limit) => controller.list(limit, expectedModel),
    inspect: (checkpointId) => controller.inspect(checkpointId, expectedModel),
    abandon: (checkpointId, reason) => controller.abandon(checkpointId, reason),
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
