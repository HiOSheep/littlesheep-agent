import type {
  DurableHarnessEvent,
  DurableHarnessEventAppendInput,
  DurableRunProjection,
} from '@littlesheep/types';

export function isDurableRunTerminal(projection: DurableRunProjection): boolean {
  return projection.status === 'completed'
    || projection.status === 'failed'
    || projection.status === 'interrupted'
    || projection.finalReply.state === 'runtime_status';
}

/**
 * Settlement events for facts that were already pending when the run became
 * terminal are audit closures, not new work. Recovery must be able to record
 * an unknown effect/model outcome without reopening a failed or interrupted
 * run.
 */
export function isTerminalAuditClosure(
  projection: DurableRunProjection,
  event: DurableHarnessEventAppendInput | DurableHarnessEvent,
): boolean {
  if (projection.status !== 'completed'
    && projection.status !== 'failed'
    && projection.status !== 'interrupted'
    && projection.finalReply.state !== 'runtime_status') return false;
  if (event.type === 'effect_settled') {
    const effectId = event.payload.effectId;
    return typeof effectId === 'string' && projection.pendingEffectIds.includes(effectId);
  }
  if (event.type === 'model_request_settled') {
    const requestId = event.payload.requestId;
    return typeof requestId === 'string' && projection.pendingModelRequestIds.includes(requestId);
  }
  return false;
}
