// Read/claim boundary for runtime checkpoints.
//
// Inspection is side-effect free. A resume claim is the only operation that
// changes disposition state, and it is delegated to the atomic disposition
// store so two processes cannot both acquire the same checkpoint.

import type {
  RunCheckpoint,
  RunCheckpointDisposition,
  SessionId,
} from '@littlesheep/types'
import {
  RunCheckpointDispositionStore,
  type RunCheckpointAnswerClaimIdentity,
  type RunCheckpointDispositionOutcome,
  type RunCheckpointResumeClaimOptions,
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
  | { kind: 'joined'; checkpoint: RunCheckpoint; disposition: RunCheckpointDisposition }
  | { kind: 'blocked'; inspection: RunCheckpointInspection }
  | { kind: 'conflict'; checkpoint: RunCheckpoint; disposition: RunCheckpointDisposition; message: string }

export type WaitingUserHeadResolution =
  | { kind: 'none' }
  | { kind: 'eligible'; checkpointId: string; requestId?: string; inspection: RunCheckpointInspection }
  | { kind: 'blocked'; checkpointId: string; reasons: string[]; inspection: RunCheckpointInspection }
  | { kind: 'conflict'; checkpointIds: string[] }

export type ResumeClaimResolution =
  | { kind: 'none' }
  | { kind: 'found'; disposition: RunCheckpointDisposition }
  | { kind: 'conflict'; checkpointIds: string[] }

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

  /** Durable claims are the authority for startup lease recovery, even outside the UI checkpoint window. */
  async listResumingDispositions(): Promise<RunCheckpointDisposition[]> {
    return this.dispositionStore.list({ statuses: ['resuming'] })
  }

  async listIncompleteResumeDispositions(): Promise<RunCheckpointDisposition[]> {
    return this.dispositionStore.list({ statuses: ['resuming', 'interrupted'] })
  }

  /** Resolve a durable conversation-turn claim independently of the bounded checkpoint UI window. */
  async resolveResumeClaim(resumeRunId: string, requestKey: string): Promise<ResumeClaimResolution> {
    const matches = await this.dispositionStore.list({ resumeRunId, requestKey, limit: 2 })
    if (matches.length === 0) return { kind: 'none' }
    if (matches.length > 1) {
      return {
        kind: 'conflict',
        checkpointIds: matches.map((item) => item.checkpointId).sort(),
      }
    }
    return { kind: 'found', disposition: matches[0]! }
  }

  /** Resolve the only auto-bindable waiting-user head without guessing by age. */
  async resolveWaitingUserHead(
    sessionId: SessionId,
    expectedModel?: string,
  ): Promise<WaitingUserHeadResolution> {
    const checkpoints = await this.checkpointStore.list({
      sessionId,
      status: 'waiting_user',
      limit: MAX_CHECKPOINT_INSPECTION_LIMIT,
    })
    const pending: RunCheckpointInspection[] = []
    for (const checkpoint of checkpoints) {
      const disposition = await this.dispositionStore.read(checkpoint.id)
      const inspection = inspectCheckpoint(checkpoint, disposition, expectedModel)
      const status = inspection.disposition?.status
      if (status === undefined || status === 'interrupted' || status === 'resuming') pending.push(inspection)
    }
    if (pending.length === 0) return { kind: 'none' }
    if (pending.length > 1) {
      return {
        kind: 'conflict',
        checkpointIds: pending.map((inspection) => inspection.checkpoint.id).sort(),
      }
    }
    const inspection = pending[0]!
    if (!inspection.resumable) {
      return {
        kind: 'blocked',
        checkpointId: inspection.checkpoint.id,
        reasons: [...inspection.reasons],
        inspection,
      }
    }
    return {
      kind: 'eligible',
      checkpointId: inspection.checkpoint.id,
      requestId: inspection.checkpoint.resumeState?.continuation?.requestId,
      inspection,
    }
  }

  /** Claim a checkpoint only after the complete immutable snapshot is safe. */
  async claimResume(
    checkpointId: string,
    reason: string,
    resumeRunId: string,
    expectedModel?: string,
    identity?: RunCheckpointAnswerClaimIdentity,
    options?: RunCheckpointResumeClaimOptions,
  ): Promise<RunCheckpointClaimOutcome> {
    const inspection = await this.inspect(checkpointId, expectedModel)
    if (!inspection) throw new Error(`run checkpoint not found: ${checkpointId}`)
    const joinsActiveClaim = Boolean(
      identity
      && inspection.disposition?.status === 'resuming'
      && inspection.disposition.requestId === identity.requestId
      && inspection.disposition.answerMessageId === identity.answerMessageId
      && inspection.disposition.requestKey === identity.requestKey,
    )
    if (!inspection.resumable && !joinsActiveClaim) {
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
      identity,
      options,
    )
    if (outcome.kind === 'written' || outcome.kind === 'duplicate') {
      return {
        kind: outcome.kind === 'written' ? 'claimed' : 'joined',
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

  async reconcileCompletedResume(
    checkpointId: string,
    resumeRunId: string,
    resultStatus: 'ok' | 'error' | 'aborted',
    reason: string,
    nextCheckpointId?: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    return this.dispositionStore.reconcileCompletedResume(
      checkpointId,
      resumeRunId,
      resultStatus,
      reason,
      nextCheckpointId,
    )
  }

  async completeSourceRun(
    checkpointId: string,
    sourceRunId: string,
    reason: string,
  ): Promise<RunCheckpointDispositionOutcome | null> {
    const checkpoint = await this.checkpointStore.read(checkpointId)
    if (!checkpoint) throw new Error(`run checkpoint not found: ${checkpointId}`)
    if (String(checkpoint.runId) !== sourceRunId) {
      throw new Error(`run checkpoint ${checkpointId} does not belong to source run ${sourceRunId}`)
    }
    // A successful source run may seal intermediate recovery snapshots, but a
    // waiting/paused checkpoint is the durable continuation head itself.
    if (checkpoint.status !== 'recoverable') return null
    return this.dispositionStore.completeSourceRun(checkpointId, reason)
  }

  async interruptResume(
    checkpointId: string,
    resumeRunId: string,
    reason: string,
    nextCheckpointId?: string,
  ): Promise<RunCheckpointDispositionOutcome> {
    return this.dispositionStore.interruptResume(checkpointId, resumeRunId, reason, nextCheckpointId)
  }

  async abandon(
    checkpointId: string,
    reason: string,
    identity?: RunCheckpointAnswerClaimIdentity,
  ): Promise<RunCheckpointDispositionOutcome> {
    return this.dispositionStore.abandon(checkpointId, reason, identity)
  }

  async defer(
    checkpointId: string,
    reason: string,
    identity?: RunCheckpointAnswerClaimIdentity,
  ): Promise<RunCheckpointDispositionOutcome> {
    return this.dispositionStore.defer(checkpointId, reason, identity)
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
    const restorableCount = checkpoint.resumeState.attachments?.length ?? 0
    if (restorableCount !== checkpoint.resumeState.attachmentCount) {
      reasons.push('checkpoint references legacy or incomplete attachments; reattach the missing resources before continuing')
    }
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
  if (disposition?.status === 'completed') reasons.push('checkpoint source run has already completed')
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
