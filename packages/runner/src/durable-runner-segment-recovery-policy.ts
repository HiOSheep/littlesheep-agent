import type {
  DurableHarnessEvent,
  DurableRunProjection,
  RunCheckpoint,
  SessionId,
} from '@littlesheep/types';

/**
 * Automatic same-Run execution is limited to a fully settled, explicitly
 * checkpointed segment boundary. Missing legacy fields intentionally decline.
 */
export function isSafeSegmentBoundary(checkpoint: RunCheckpoint): boolean {
  return checkpoint.status === 'recoverable'
    && checkpoint.currentStage === 'execute'
    && checkpoint.reason === 'execution-segment-started'
    && checkpoint.safeSegmentBoundary?.version === 1
    && checkpoint.safeSegmentBoundary.kind === 'execution_segment'
    && checkpoint.resumeState !== undefined
    && checkpoint.runtimeControl?.state !== 'paused'
    && checkpoint.runtimeControl?.state !== 'interrupted'
    && checkpoint.loopBudget.segmentIterationsUsed === 0
    && checkpoint.loopBudget.executionSegmentIndex !== undefined
    && checkpoint.pendingEventIds.length === 0
    && !(checkpoint.runtimeEventQueue?.events ?? []).some((event) => event.status === 'queued')
    && checkpoint.sideEffects.every((effect) => (
      effect.status === 'succeeded' || effect.status === 'failed' || effect.status === 'cancelled'
    ));
}

export function isEligibleSameRunSegmentRecovery(
  checkpoint: RunCheckpoint,
  projection: DurableRunProjection,
  events: readonly DurableHarnessEvent[],
  sessionId: SessionId,
  runId: string,
): boolean {
  const boundaryEvent = events.some((event) => (
    event.type === 'checkpoint_written'
    && event.payload.checkpointId === checkpoint.id
  ));
  const acceptedEvents = events.filter((event) => event.type === 'run_accepted');
  const inputEvents = events.filter((event) => event.type === 'user_input_appended');
  return isSafeSegmentBoundary(checkpoint)
    && String(checkpoint.sessionId) === String(sessionId)
    && checkpoint.runId === runId
    && projection.sessionId === String(sessionId)
    && projection.runId === runId
    && projection.status === 'running'
    && projection.route === 'execute'
    && projection.finalReply.state === 'none'
    && projection.pendingModelRequestIds.length === 0
    && projection.pendingEffectIds.length === 0
    && projection.unknownEffectIds.length === 0
    && projection.modelRequests.every((request) => (
      request.status === 'received' && request.providerReachStatus === 'reached'
    ))
    && projection.effects.every((effect) => (
      effect.status === 'succeeded' || effect.status === 'failed' || effect.status === 'cancelled'
    ))
    && !events.some((event) => (
      event.type === 'run_completed'
      || event.type === 'run_failed'
      || event.type === 'run_interrupted'
      || (event.type === 'runtime_status_settled' && event.payload.reason === 'waiting_user')
    ))
    && boundaryEvent
    && acceptedEvents.length === 1
    && inputEvents.length === 1
    && inputEvents[0]?.payload.messageId === checkpoint.resumeState?.inboundMessageId
    && checkpoint.loopBudget.attemptsUsed < checkpoint.loopBudget.maxAttempts
    && (checkpoint.loopBudget.maxToolCalls === undefined
      || (checkpoint.loopBudget.toolCallsUsed ?? 0) < checkpoint.loopBudget.maxToolCalls)
    && ((checkpoint.loopBudget.maxToolLoopIterationsPerRun ?? checkpoint.loopBudget.maxToolLoopIterations) === undefined
      || (checkpoint.loopBudget.toolLoopIterationsUsed ?? 0)
        < (checkpoint.loopBudget.maxToolLoopIterationsPerRun ?? checkpoint.loopBudget.maxToolLoopIterations)!)
    && (checkpoint.loopBudget.maxElapsedMs <= 0
      || checkpoint.loopBudget.elapsedMs < checkpoint.loopBudget.maxElapsedMs)
    && checkpoint.loopBudget.noProgressRounds < checkpoint.loopBudget.maxNoProgressRounds;
}
