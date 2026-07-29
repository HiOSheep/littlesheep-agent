// Read/claim boundary for runtime checkpoints.
//
// Inspection is side-effect free. A resume claim is the only operation that
// changes disposition state, and it is delegated to the atomic disposition
// store so two processes cannot both acquire the same checkpoint.

import type {
  RunCheckpoint,
  RunCheckpointDisposition,
} from '@littlesheep/types'
import {
  RunCheckpointDispositionStore,
  type RunCheckpointDispositionOutcome,
} from './run-checkpoint-disposition-store.js'
import { RunCheckpointStore } from './run-checkpoint-store.js'

export const DEFAULT_CHECKPOINT_INSPECTION_LIMIT = 64 as const
export const MAX_CHECKPOINT_INSPECTION_LIMIT = 128 as const

export interface RunCheckpointInspection {
  checkpoint: RunCheckpoint
  disposition: RunCheckpointDisposition | null
  resumable: boolean
  reasons: string[]
}

export type RunCheckpointClaimOutcome =
  | { kind: 'claimed'; checkpoint: RunCheckpoint; disposition: RunCheckpointDisposition }
  | { kind: 'blocked'; inspection: RunCheckpointInspection }
  | { kind: 'conflict'; checkpoint: RunCheckpoint; disposition: RunCheckpointDisposition; message: string }

export interface RunCheckpointControllerOptions {
  checkpointStore: RunCheckpointStore
  dispositionStore: RunCheckpointDispositionStore
}

export class RunCheckpointController {
  private readonly checkpointStore: RunCheckpointStore
  private readonly dispositionStore: RunCheckpointDispositionStore

  constructor(options: RunCheckpointControllerOptions) {
    this.checkpointStore = options.checkpointStore
    this.dispositionStore = options.dispositionStore
  }

  /** Inspect one checkpoint without claiming, rewriting, or refreshing it. */
  async inspect(checkpointId: string, expectedModel?: string): Promise<RunCheckpointInspection | null> {
    const checkpoint = await this.checkpointStore.read(checkpointId)
    if (!checkpoint) return null
    const disposition = await this.dispositionStore.read(checkpoint.id)
    return inspectCheckpoint(checkpoint, disposition, expectedModel)
  }

  /** Return a bounded newest-first view suitable for startup/UI diagnostics. */
  async list(limit: number = DEFAULT_CHECKPOINT_INSPECTION_LIMIT, expectedModel?: string): Promise<RunCheckpointInspection[]> {
    const boundedLimit = boundedInteger(limit, DEFAULT_CHECKPOINT_INSPECTION_LIMIT, 1, MAX_CHECKPOINT_INSPECTION_LIMIT)
    const checkpoints = await this.checkpointStore.list({ limit: boundedLimit })
    const result: RunCheckpointInspection[] = []
    for (const checkpoint of checkpoints) {
      const disposition = await this.dispositionStore.read(checkpoint.id)
      result.push(inspectCheckpoint(checkpoint, disposition, expectedModel))
    }
    return result
  }

  /** Claim a checkpoint only after the complete immutable snapshot is safe. */
  async claimResume(
    checkpointId: string,
    reason: string,
    resumeRunId: string,
    expectedModel?: string,
  ): Promise<RunCheckpointClaimOutcome> {
    const inspection = await this.inspect(checkpointId, expectedModel)
    if (!inspection) throw new Error(`run checkpoint not found: ${checkpointId}`)
    if (!inspection.resumable) {
      if (inspection.disposition) {
        return {
          kind: 'conflict',
          checkpoint: inspection.checkpoint,
          disposition: inspection.disposition,
          message: inspection.reasons.join('; '),
        }
      }
      return { kind: 'blocked', inspection }
    }

    const outcome = await this.dispositionStore.claimResume(
      inspection.checkpoint.id,
      reason,
      resumeRunId,
    )
    if (outcome.kind === 'written') {
      return {
        kind: 'claimed',
        checkpoint: inspection.checkpoint,
        disposition: outcome.disposition,
      }
    }
    return {
      kind: 'conflict',
      checkpoint: inspection.checkpoint,
      disposition: outcome.disposition,
      message: outcome.kind === 'conflict'
        ? outcome.message
        : 'checkpoint is already claimed by another resume attempt',
    }
  }

  async completeResume(
    checkpointId: string,
    resumeRunId: string,
    resultStatus: 'ok' | 'error' | 'aborted',
    reason: string,
    nextCheckpointId?: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    return this.dispositionStore.completeResume(
      checkpointId,
      resumeRunId,
      resultStatus,
      reason,
      nextCheckpointId,
    )
  }

  async interruptResume(
    checkpointId: string,
    resumeRunId: string,
    reason: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    return this.dispositionStore.interruptResume(checkpointId, resumeRunId, reason)
  }

  async abandon(checkpointId: string, reason: string): Promise<RunCheckpointDispositionOutcome> {
    return this.dispositionStore.abandon(checkpointId, reason)
  }
}

function inspectCheckpoint(
  checkpoint: RunCheckpoint,
  disposition: RunCheckpointDisposition | null,
  expectedModel?: string,
): RunCheckpointInspection {
  const reasons: string[] = []
  if (!checkpoint.resumeState) reasons.push('checkpoint has no resumable runtime state')
  if (checkpoint.resumeState?.attachmentCount && checkpoint.resumeState.attachmentCount > 0) {
    reasons.push('checkpoint references attachments that are not restorable from this snapshot')
  }
  if (expectedModel && checkpoint.resumeState?.model !== expectedModel) {
    reasons.push('checkpoint model does not match the active runner model')
  }
  const uncertainEffects = checkpoint.sideEffects.filter((effect) => (
    effect.status === 'in_progress' || effect.status === 'unknown'
  ))
  if (uncertainEffects.length > 0) {
    reasons.push(`checkpoint contains ${uncertainEffects.length} side effect(s) without verified completion evidence`)
  }
  if (disposition?.status === 'resuming') reasons.push('checkpoint has an active resume lease')
  if (disposition?.status === 'resumed') reasons.push('checkpoint has already been resumed')
  if (disposition?.status === 'abandoned') reasons.push('checkpoint was explicitly abandoned')
  return {
    checkpoint,
    disposition,
    resumable: reasons.length === 0,
    reasons,
  }
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}
