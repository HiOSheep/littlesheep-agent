// Bounded application-facing control surface for durable run checkpoints.

import type { RunCheckpointDispositionOutcome } from './run-checkpoint-disposition-store.js'
import type {
  RunCheckpointInspection,
  RunCheckpointController,
  WaitingUserHeadResolution,
} from './run-checkpoint-controller.js'
import type { SessionId } from '@littlesheep/types'
import type { RunCheckpointStore, RunCheckpointStoreDiagnostics } from './run-checkpoint-store.js'
import type { ExecutionLogStore } from './execution-log.js'

export interface RunCheckpointControl {
  list(limit?: number): Promise<RunCheckpointInspection[]>
  inspect(checkpointId: string): Promise<RunCheckpointInspection | null>
  resolveWaitingUserHead(sessionId: SessionId): Promise<WaitingUserHeadResolution>
  abandon(checkpointId: string, reason: string): Promise<RunCheckpointDispositionOutcome>
  defer(checkpointId: string, reason: string): Promise<RunCheckpointDispositionOutcome>
  /** Reconcile successful execution logs with intermediate checkpoints left by older builds or crashes. */
  reconcileCompletedRuns(reason: string): Promise<number>
  /** Convert process-local resume leases into auditable, resumable interruptions. */
  recoverInterruptedResumes(reason: string): Promise<number>
  diagnostics(): RunCheckpointStoreDiagnostics
}

export function createRunCheckpointControl(
  controller: RunCheckpointController | undefined,
  checkpointStore: Pick<RunCheckpointStore, 'diagnostics' | 'latestForRun' | 'list'> | undefined,
  executionLogStore: Pick<ExecutionLogStore, 'read'> | undefined,
  expectedModel: string,
): RunCheckpointControl | undefined {
  if (!controller || !checkpointStore) return undefined
  return {
    list: (limit) => controller.list(limit, expectedModel),
    inspect: (checkpointId) => controller.inspect(checkpointId, expectedModel),
    resolveWaitingUserHead: (sessionId) => controller.resolveWaitingUserHead(sessionId, expectedModel),
    abandon: (checkpointId, reason) => controller.abandon(checkpointId, reason),
    defer: (checkpointId, reason) => controller.defer(checkpointId, reason),
    reconcileCompletedRuns: async (reason) => {
      if (!executionLogStore) return 0
      const incompleteResumes = await controller.listIncompleteResumeDispositions()
      const reconciledResumeRunIds = new Set<string>()
      let reconciled = 0
      for (const disposition of incompleteResumes) {
        if (!disposition.resumeRunId) continue
        const log = await executionLogStore.read(disposition.resumeRunId)
        if (log?.status !== 'ok') continue
        const outcome = await controller.reconcileCompletedResume(
          disposition.checkpointId,
          disposition.resumeRunId,
          'ok',
          reason,
          log.runCheckpointId ?? disposition.nextCheckpointId,
        )
        if (outcome.kind === 'written') reconciled += 1
        if (outcome.kind !== 'conflict') reconciledResumeRunIds.add(disposition.resumeRunId)
      }

      const checkpoints = await checkpointStore.list()
      const sourceRunIds = [...new Set(checkpoints.map((checkpoint) => String(checkpoint.runId)))]
      for (const sourceRunId of sourceRunIds) {
        if (reconciledResumeRunIds.has(sourceRunId)) continue
        const log = await executionLogStore.read(sourceRunId)
        if (log?.status !== 'ok' || !log.runCheckpointId) continue
        const checkpoint = await controller.inspect(log.runCheckpointId)
        if (!checkpoint || String(checkpoint.checkpoint.runId) !== sourceRunId) continue
        const outcome = await controller.completeSourceRun(log.runCheckpointId, sourceRunId, reason)
        if (outcome?.kind === 'written') reconciled += 1
      }
      return reconciled
    },
    recoverInterruptedResumes: async (reason) => {
      const dispositions = await controller.listResumingDispositions()
      let recovered = 0
      for (const disposition of dispositions) {
        if (!disposition.resumeRunId) continue
        const latestForResume = await checkpointStore.latestForRun(disposition.resumeRunId)
        const continuationCheckpoint = latestForResume?.id !== disposition.checkpointId
          ? latestForResume
          : undefined
        const outcome = await controller.interruptResume(
          disposition.checkpointId,
          disposition.resumeRunId,
          reason,
          continuationCheckpoint?.id,
        )
        if (outcome.kind !== 'conflict') recovered += 1
      }
      return recovered
    },
    diagnostics: () => checkpointStore.diagnostics(),
  }
}
