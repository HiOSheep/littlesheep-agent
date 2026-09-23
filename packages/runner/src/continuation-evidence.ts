// The continuation audit record: what one conversation turn did to an existing
// task. Split out of `runner.ts` (which owns the run lifecycle and only composes
// these facts) because the record has three shapes — a bound/deferred/abandoned
// turn, a shadow audit of an eligible head, and a turn the coordinator rejected
// before execution — and each one is written from checkpoint facts alone.
import type {
  ConversationContinuationEvidence,
  PermissionPolicyId,
  RunCheckpoint,
  StageName,
} from '@littlesheep/types'
import { conversationTurnMessageId } from './conversation-turn.js'
import type { ContinuationDispositionDecision } from './continuation-disposition.js'
import { continuationLoopBudget } from './run-checkpoint.js'
import type { WaitingUserHeadResolution } from './run-checkpoint-controller.js'
import type { RunInput } from './runner.js'

/** What a continuation handed over, and what it deliberately did not. */
const MAX_PREVIOUS_FAILURE_MESSAGE = 2_048

export function continuationFailureEvidence(input: {
  input: RunInput
  resolution: 'blocked' | 'conflict'
  checkpoint?: RunCheckpoint
  candidateCheckpointIds?: string[]
  requestId?: string
  answerMessageId?: string
  code: NonNullable<ConversationContinuationEvidence['failure']>['code']
  detail: string
  recoverable: boolean
  resourceStatus?: NonNullable<ConversationContinuationEvidence['resources']>['status']
  inputDigest?: string
}): ConversationContinuationEvidence {
  const checkpoint = input.checkpoint
  const state = checkpoint?.resumeState
  const taskSteps = checkpoint?.taskExecution?.steps ?? []
  const sideEffects = checkpoint?.sideEffects ?? []
  const turnId = input.input.sessionId
    ? conversationTurnMessageId(input.input.sessionId, input.input.requestKey)
    : undefined
  return {
    version: 1,
    resolution: input.resolution,
    ...(turnId ? { turnId } : {}),
    ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
    ...(checkpoint ? { checkpointId: checkpoint.id, sourceRunId: String(checkpoint.runId) } : {}),
    ...(input.candidateCheckpointIds ? { candidateCheckpointIds: [...input.candidateCheckpointIds] } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.answerMessageId ? { answerMessageId: input.answerMessageId } : {}),
    ...(input.input.runId ? { resumeRunId: input.input.runId } : {}),
    ...(state ? {
      resources: {
        status: input.resourceStatus ?? 'not_required',
        attachmentCount: state.attachmentCount,
        toolRecipeCount: state.toolRecipes?.length ?? 0,
        restoredToolCount: 0,
      },
      permissions: {
        checkpoint: state.permissionPolicyId,
        current: input.input.permissionPolicyId ?? 'research',
      },
      replayPrevention: {
        completedStepCountPreserved: taskSteps.filter((step) => step.status === 'done').length,
        succeededSideEffectCountPreserved: sideEffects.filter((effect) => effect.status === 'succeeded').length,
        uncertainSideEffectCount: sideEffects.filter((effect) => (
          effect.status === 'in_progress' || effect.status === 'unknown'
        )).length,
        answerMessageAlreadyPersisted: false,
      },
    } : {}),
    failure: {
      code: input.code,
      detail: input.detail.slice(0, 4_096),
      recoverable: input.recoverable,
    },
  }
}

export function shadowContinuationEvidence(
  base: ConversationContinuationEvidence,
  resolution: WaitingUserHeadResolution,
  currentPermission: PermissionPolicyId,
): ConversationContinuationEvidence {
  if (resolution.kind === 'none') return base
  if (resolution.kind === 'conflict') {
    return {
      ...base,
      resolution: 'conflict',
      candidateCheckpointIds: [...resolution.checkpointIds],
    }
  }
  const checkpoint = resolution.inspection.checkpoint
  const state = checkpoint.resumeState
  return {
    ...base,
    resolution: resolution.kind === 'eligible' ? 'eligible' : 'blocked',
    checkpointId: checkpoint.id,
    sourceRunId: String(checkpoint.runId),
    ...(state?.continuation?.requestId ? { requestId: state.continuation.requestId } : {}),
    ...(state ? {
      resources: {
        status: resolution.kind === 'blocked' && state.attachmentCount > 0 ? 'failed' : 'not_required',
        attachmentCount: state.attachmentCount,
        toolRecipeCount: state.toolRecipes?.length ?? 0,
        restoredToolCount: 0,
      },
      permissions: {
        checkpoint: state.permissionPolicyId,
        current: currentPermission,
      },
    } : {}),
  }
}

export function buildConversationContinuationEvidence(input: {
  checkpoint: RunCheckpoint
  restoredCheckpoint?: RunCheckpoint
  turnId?: string
  inputDigest?: string
  resolution: Extract<ConversationContinuationEvidence['resolution'], 'bound' | 'deferred' | 'abandoned'>
  requestId?: string
  answerMessageId?: string
  resumeRunId: string
  decision?: ContinuationDispositionDecision
  resumeStage: StageName
  resumeRule: string
  resourceStatus: NonNullable<ConversationContinuationEvidence['resources']>['status']
  restoredAttachmentCount?: number
  restoredToolCount?: number
  currentPermission: PermissionPolicyId
  answerMessageAlreadyPersisted: boolean
  /**
   * The provider-call ceiling this run starts with, from the current
   * configuration — the same value `buildRunContext` writes to `ctx.maxModelCalls`.
   * Reported so the evidence names the allowance the continuation actually got.
   */
  modelCallsAllowed?: number
}): ConversationContinuationEvidence {
  const restored = input.restoredCheckpoint ?? input.checkpoint
  const taskSteps = restored.taskExecution?.steps ?? []
  const sideEffects = restored.sideEffects
  const inheritedFailure = restored.resumeState?.lastError
  const handoffBudget = input.modelCallsAllowed === undefined
    ? undefined
    : continuationLoopBudget(restored.loopBudget, input.modelCallsAllowed)
  return {
    version: 1,
    resolution: input.resolution,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
    checkpointId: input.checkpoint.id,
    sourceRunId: String(input.checkpoint.runId),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.answerMessageId ? { answerMessageId: input.answerMessageId } : {}),
    resumeRunId: input.resumeRunId,
    ...(input.decision && input.decision.kind !== 'ambiguous'
      ? { disposition: input.decision.kind, dispositionSource: input.decision.source }
      : {}),
    resumeStage: input.resumeStage,
    resumeRule: input.resumeRule.slice(0, 256),
    resources: {
      status: input.resourceStatus,
      attachmentCount: input.restoredAttachmentCount ?? 0,
      toolRecipeCount: restored.resumeState?.toolRecipes?.length ?? 0,
      restoredToolCount: input.restoredToolCount ?? 0,
    },
    permissions: {
      checkpoint: input.checkpoint.resumeState?.permissionPolicyId ?? 'research',
      current: input.currentPermission,
    },
    replayPrevention: {
      completedStepCountPreserved: taskSteps.filter((step) => step.status === 'done').length,
      succeededSideEffectCountPreserved: sideEffects.filter((effect) => effect.status === 'succeeded').length,
      uncertainSideEffectCount: sideEffects.filter((effect) => (
        effect.status === 'in_progress' || effect.status === 'unknown'
      )).length,
      answerMessageAlreadyPersisted: input.answerMessageAlreadyPersisted,
    },
    // Only a bound turn continues the work; a deferred new task or an abandoned
    // task hands nothing over, so there is no hand-off to report for them.
    ...(input.resolution === 'bound' && handoffBudget
      ? {
          handoff: {
            ...(inheritedFailure
              ? {
                  previousFailure: {
                    stage: inheritedFailure.stage,
                    message: inheritedFailure.message.slice(0, MAX_PREVIOUS_FAILURE_MESSAGE),
                  },
                }
              : {}),
            runBudget: {
              previousModelCallsUsed: restored.loopBudget.attemptsUsed,
              previousToolLoopIterationsUsed: restored.loopBudget.toolLoopIterationsUsed ?? 0,
              modelCallsAllowed: handoffBudget.maxAttempts,
              toolLoopIterationsAllowed: handoffBudget.maxToolLoopIterations ?? 0,
            },
          },
        }
      : {}),
  }
}
