// Recovery coordinator for completed conversation turns after Runner restart.
// It owns the explicit Session, durable-event, execution-log, and checkpoint
// ports used to reconcile and replay an already accepted turn.
import { reduceDurableRunProjection } from '@littlesheep/harness'
import type {
  ConversationContinuationEvidence,
  DurableRunProjection,
  FinalReplyReservation,
  FinalReplySettlement,
  SessionId,
  StageName,
} from '@littlesheep/types'
import { continuationFailureEvidence } from './continuation-evidence.js'
import { conversationTurnMessageId } from './conversation-turn.js'
import type { Infrastructure, LogFn } from './infra.js'
import type { RunCheckpointController } from './run-checkpoint-controller.js'
import { resolveSemanticResumeStage } from './continuation-stage.js'
import { messageText } from './runner-support.js'
import type { RunInput, RunnerResult } from './runner.js'

export class ContinuationControlError extends Error {
  constructor(
    message: string,
    readonly evidence: ConversationContinuationEvidence,
  ) {
    super(message)
    this.name = 'ContinuationControlError'
  }
}

export interface ConversationTurnRecoveryOptions {
  sessionManager: Infrastructure['sessionManager']
  durableEventStore: Infrastructure['durableEventStore']
  executionLogStore: Infrastructure['executionLogStore']
  runCheckpointStore: Infrastructure['runCheckpointStore']
  model: string
  log?: LogFn
  checkpointController?: RunCheckpointController
  recoverDurableProjectionForRetry(sessionId: SessionId, runId: string): Promise<void>
  prepareInternalAuthoritativeResult(result: RunnerResult): Promise<RunnerResult>
}

export function createConversationTurnRecovery(options: ConversationTurnRecoveryOptions) {
  const {
    sessionManager,
    durableEventStore,
    executionLogStore,
    runCheckpointStore,
    model,
    log,
    checkpointController,
    recoverDurableProjectionForRetry,
    prepareInternalAuthoritativeResult,
  } = options
  return async function recoverCompletedConversationTurn(
    input: RunInput & { sessionId: SessionId; requestKey: string },
    stableRunId: string,
    inputDigest: string,
    explicitCheckpointId?: string,
  ): Promise<RunnerResult | null> {
    const messages = await sessionManager.read(input.sessionId)
    const turnId = conversationTurnMessageId(input.sessionId, input.requestKey)!
    const stableInbound = messages.find((message) => message.id === turnId)
    if (stableInbound && (stableInbound.role !== 'user' || messageText(stableInbound) !== input.text.trim())) {
      throw new ContinuationControlError(
        'conversation request key conflicts with a different persisted session message',
        continuationFailureEvidence({
          input: { ...input, runId: stableRunId },
          resolution: 'conflict',
          code: 'turn_identity_conflict',
          detail: 'persisted stable inbound message does not match the retried turn',
          recoverable: false,
          inputDigest,
        }),
      )
    }

    // A durable Runtime terminal status is authoritative even when the
    // execution-log write failed. A retried request must not fall through to
    // appendIfAbsent (which would report an internal "already accepted"
    // error) or re-enter the model/tool loop. Return a bounded Runtime result
    // reconstructed from the durable projection instead.
    let durableProjection: import('@littlesheep/types').DurableRunProjection | undefined
    try {
      durableProjection = reduceDurableRunProjection(await durableEventStore.read(
        String(input.sessionId),
        stableRunId,
      ))
    } catch {
      durableProjection = undefined
    }
    if (durableProjection && durableProjection.eventCount > 0) {
      // If the process died after writing a proposal, make one conservative
      // recovery pass before deciding what a retry may observe. Recovery only
      // appends bounded facts; it never invokes a model or tool.
      if (!isDurableProjectionTerminalForRetry(durableProjection)) {
        await recoverDurableProjectionForRetry(input.sessionId, stableRunId)
          .catch(() => undefined)
        try {
          durableProjection = reduceDurableRunProjection(await durableEventStore.read(
            String(input.sessionId),
            stableRunId,
          ))
        } catch {
          durableProjection = undefined
        }
      }
      if (durableProjection && (
        durableProjection.finalReply.state === 'runtime_status'
        || (isDurableProjectionTerminalForRetry(durableProjection)
          && durableProjection.finalReply.state !== 'settled')
      )) {
        return prepareInternalAuthoritativeResult({
          runId: stableRunId,
          sessionId: input.sessionId,
          status: 'error',
          reply: '',
          messages: [],
          trace: [],
          durationMs: 0,
        })
      }
    }
    const runMessages = messages.filter((message) => message.runId === stableRunId)
    const finalReply = [...runMessages].reverse().find((message) => (
      message.role === 'assistant'
      && message.stage === 'finalize'
      && Boolean(messageText(message).trim())
    ))
    if (!finalReply) return null

    let authoritativeSettlement: FinalReplySettlement | undefined;
    let authoritativeReply = messageText(finalReply).trim();
    const durableFinalReply = durableProjection?.finalReply;
    if (durableFinalReply?.state === 'settled') {
      if (!durableFinalReply.settlementId
        || !durableFinalReply.reply
        || !durableFinalReply.replyFingerprint
        || !durableFinalReply.modelRequestId) {
        return null;
      }
      authoritativeSettlement = {
        version: 1,
        settlementId: durableFinalReply.settlementId,
        reply: durableFinalReply.reply,
        replyFingerprint: durableFinalReply.replyFingerprint,
        modelRequestId: durableFinalReply.modelRequestId,
        status: 'settled',
      };
      authoritativeReply = durableFinalReply.reply;
    }

    // A new-path transcript message is only a proposal until both the session
    // settlement registry and durable event projection confirm the same
    // identity. Legacy messages without this field retain their old replay
    // behavior for backward compatibility.
    if (finalReply.finalReplySettlement) {
      const settlement = finalReply.finalReplySettlement;
      const registryStatus = await sessionManager.assistantReplySettlementStatus?.(
        input.sessionId,
        settlement.settlementId,
      );
      if (registryStatus !== 'settled') return null;
      let projection: import('@littlesheep/types').DurableRunProjection;
      try {
        projection = reduceDurableRunProjection(await durableEventStore.read(
          String(input.sessionId),
          stableRunId,
        ));
      } catch {
        return null;
      }
      if (projection.finalReply.state !== 'settled'
        || projection.finalReply.settlementId !== settlement.settlementId) return null;
      if (!authoritativeSettlement
        && projection.finalReply.reply
        && projection.finalReply.replyFingerprint
        && projection.finalReply.modelRequestId) {
        authoritativeSettlement = {
          version: 1,
          settlementId: settlement.settlementId,
          reply: projection.finalReply.reply,
          replyFingerprint: projection.finalReply.replyFingerprint,
          modelRequestId: projection.finalReply.modelRequestId,
          status: 'settled',
        };
        authoritativeReply = projection.finalReply.reply;
      }
    }

    if (authoritativeSettlement) {
      const reservation: FinalReplyReservation = {
        version: authoritativeSettlement.version,
        settlementId: authoritativeSettlement.settlementId,
        reply: authoritativeSettlement.reply,
        replyFingerprint: authoritativeSettlement.replyFingerprint,
        modelRequestId: authoritativeSettlement.modelRequestId,
      };
      await sessionManager.settleAssistantReplySettlement(input.sessionId, reservation)
        .catch((error) => {
          // The durable event and registry remain authoritative; a transcript
          // rewrite can be retried without re-running the conversation turn.
          log?.('error', 'runner: failed to repair settled transcript proposal: ' + (error as Error).message);
        });
    }

    let sourceInspection = explicitCheckpointId
      ? await checkpointController?.inspect(explicitCheckpointId, model)
      : null
    if (!sourceInspection && checkpointController) {
      const resolution = await checkpointController.resolveResumeClaim(stableRunId, input.requestKey)
      if (resolution.kind === 'conflict') {
        throw new ContinuationControlError(
          'conversation completion receipt matches multiple durable resume claims',
          continuationFailureEvidence({
            input: { ...input, runId: stableRunId },
            resolution: 'conflict',
            candidateCheckpointIds: resolution.checkpointIds,
            code: 'turn_identity_conflict',
            detail: 'multiple checkpoint dispositions claim the same resume run and request key',
            recoverable: false,
            inputDigest,
          }),
        )
      }
      sourceInspection = resolution.kind === 'found'
        ? await checkpointController.inspect(resolution.disposition.checkpointId, model)
        : null
    }
    const sourceCheckpoint = sourceInspection?.checkpoint
    const disposition = sourceInspection?.disposition
    if (!stableInbound && disposition?.answerMessageId !== turnId) return null

    const nextCheckpoint = disposition?.nextCheckpointId && runCheckpointStore
      ? await runCheckpointStore.read(disposition.nextCheckpointId)
      : null
    const recoveredState = nextCheckpoint ?? sourceCheckpoint
    const reply = authoritativeReply
    const startedAt = stableInbound?.timestamp ?? runMessages[0]?.timestamp ?? finalReply.timestamp
    const durationMs = Math.max(0, Date.parse(finalReply.timestamp) - Date.parse(startedAt))
    let resumeStage: StageName | undefined
    if (sourceCheckpoint) {
      try {
        resumeStage = resolveSemanticResumeStage(
          sourceCheckpoint,
          sourceCheckpoint.resumeState?.continuation?.sourceStage,
        )
      } catch {
        resumeStage = undefined
      }
    }
    const continuation: ConversationContinuationEvidence = sourceCheckpoint && disposition
      ? {
          version: 1,
          resolution: 'bound',
          turnId,
          inputDigest,
          checkpointId: sourceCheckpoint.id,
          sourceRunId: String(sourceCheckpoint.runId),
          ...(disposition.requestId ? { requestId: disposition.requestId } : {}),
          ...(disposition.answerMessageId ? { answerMessageId: disposition.answerMessageId } : {}),
          resumeRunId: stableRunId,
          ...(disposition.continuationDisposition
            ? { disposition: disposition.continuationDisposition, dispositionSource: 'runtime_fallback' as const }
            : {}),
          ...(resumeStage ? { resumeStage } : {}),
          resumeRule: 'durable-session-completion-receipt->replay',
          ...(sourceCheckpoint.resumeState ? {
            resources: {
              status: sourceCheckpoint.resumeState.attachmentCount > 0
                || (sourceCheckpoint.resumeState.toolRecipes?.length ?? 0) > 0
                ? 'restored'
                : 'not_required',
              attachmentCount: sourceCheckpoint.resumeState.attachmentCount,
              toolRecipeCount: sourceCheckpoint.resumeState.toolRecipes?.length ?? 0,
              restoredToolCount: sourceCheckpoint.resumeState.toolRecipes?.length ?? 0,
            },
            permissions: {
              checkpoint: sourceCheckpoint.resumeState.permissionPolicyId,
              current: input.permissionPolicyId ?? 'research',
            },
          } : {}),
          replayPrevention: {
            completedStepCountPreserved: recoveredState?.taskExecution?.steps
              .filter((step) => step.status === 'done').length ?? 0,
            succeededSideEffectCountPreserved: recoveredState?.sideEffects
              .filter((effect) => effect.status === 'succeeded').length ?? 0,
            uncertainSideEffectCount: recoveredState?.sideEffects
              .filter((effect) => effect.status === 'in_progress' || effect.status === 'unknown').length ?? 0,
            answerMessageAlreadyPersisted: true,
          },
        }
      : { version: 1, resolution: 'none', turnId, inputDigest }
    const result: RunnerResult = {
      runId: stableRunId,
      sessionId: input.sessionId,
      status: 'ok',
      reply,
      replyProvenance: finalReply.replyProvenance,
      finalReplySettlement: authoritativeSettlement ?? finalReply.finalReplySettlement,
      messages: authoritativeSettlement
        ? runMessages.map((message) => (
            message.role === 'assistant' && message.stage === 'finalize'
              ? { ...message, finalReplySettlement: authoritativeSettlement }
              : message
          ))
        : runMessages,
      trace: [],
      durationMs,
      conversationContinuation: continuation,
      taskBook: recoveredState?.taskBook,
      taskExecution: recoveredState?.taskExecution,
      verificationHistory: recoveredState?.resumeState?.verificationHistory,
      sideEffects: recoveredState?.sideEffects,
      runtimeControl: recoveredState?.runtimeControl,
      ...(disposition?.nextCheckpointId ? { runCheckpointId: disposition.nextCheckpointId } : {}),
    }
    const endedAt = finalReply.timestamp
    await executionLogStore.write({
      runId: stableRunId,
      sessionId: String(input.sessionId),
      startedAt,
      endedAt,
      status: 'ok',
      model,
      inboundText: input.text,
      reply,
      replyProvenance: finalReply.replyProvenance,
      finalReplySettlement: authoritativeSettlement ?? finalReply.finalReplySettlement,
      trace: [],
      taskExecution: recoveredState?.taskExecution,
      taskBook: recoveredState?.taskBook,
      verificationHistory: recoveredState?.resumeState?.verificationHistory,
      conversationContinuation: continuation,
      sideEffects: recoveredState?.sideEffects,
      runtimeControl: recoveredState?.runtimeControl,
      runCheckpointId: disposition?.nextCheckpointId,
      messages: runMessages,
      durationMs,
    }).catch((error) => {
      log?.('error', `runner: failed to materialize recovered completion log: ${(error as Error).message}`)
    })
    if (
      sourceCheckpoint
      && disposition?.resumeRunId === stableRunId
      && (disposition.status === 'resuming' || disposition.status === 'interrupted')
    ) {
      await checkpointController?.reconcileCompletedResume(
        sourceCheckpoint.id,
        stableRunId,
        'ok',
        'durable session completion receipt recovered a missing execution log',
        disposition.nextCheckpointId,
      ).catch((error) => {
        log?.('error', `runner: failed to reconcile recovered completion: ${(error as Error).message}`)
      })
    }
    return result
  }
}

function isDurableProjectionTerminalForRetry(projection: DurableRunProjection): boolean {
  return projection.status === 'completed'
    || projection.status === 'failed'
    || projection.status === 'interrupted'
    || projection.finalReply.state === 'runtime_status'
}
