// Recovery ownership adapter: one process claims the durable run lease before
// the kernel can append recovery facts, then releases it after the pass.
import type { SessionManager } from '@littlesheep/session';
import type { DurableEffectProjection, DurableEffectOutcomeQueryResult, DurableRunRecoveryResult, SessionId } from '@littlesheep/types';
import type { DurableHarnessKernel } from '@littlesheep/harness';
import type { DurableRunLeaseStore } from './durable-run-lease-store.js';
import type { DurableEffectLeaseStore } from './durable-effect-lease-store.js';

export interface DurableRunRecoveryOptions {
  kernel: DurableHarnessKernel;
  leaseStore: DurableRunLeaseStore;
  effectLeaseStore: DurableEffectLeaseStore;
  sessionManager: SessionManager;
  /** Host-owned reconciliation; receives the run identity so it can resolve scope. */
  queryEffectOutcome?: (
    effect: DurableEffectProjection,
    identity: { sessionId: string; runId: string },
  ) => Promise<DurableEffectOutcomeQueryResult>;
}

export function createDurableRunRecovery(options: DurableRunRecoveryOptions): (
  sessionId: SessionId,
  runId: string,
) => Promise<DurableRunRecoveryResult> {
  return async (sessionId, runId) => {
    const acquired = await options.leaseStore.acquire(String(sessionId), runId);
    if (acquired.kind === 'conflict') {
      throw new Error(`durable run is still owned until ${acquired.lease.leaseUntil ?? 'unknown'}`);
    }
    const effectClaims: Array<{ effectId: string; ownerToken: string }> = [];
    try {
      const beforeRecovery = await options.kernel.replay(String(sessionId), runId);
      for (const effectId of beforeRecovery.pendingEffectIds) {
        const effectClaim = await options.effectLeaseStore.acquire({ sessionId: String(sessionId), runId, effectId });
        if (effectClaim.kind === 'conflict') {
          throw new Error(`durable effect is still owned until ${effectClaim.lease.leaseUntil ?? 'unknown'}`);
        }
        effectClaims.push({ effectId, ownerToken: effectClaim.lease.ownerToken! });
      }
      return await options.kernel.recoverRun(String(sessionId), runId, {
        queryEffectOutcome: options.queryEffectOutcome
          ? (effect) => options.queryEffectOutcome!(effect, { sessionId: String(sessionId), runId })
          : undefined,
        finalReplyPersisted: async (reservation) => {
          // A durable proposal is recoverable only if the matching final reply
          // itself made it into the session transcript. The registry's
          // "reserved" state alone is not proof: reservation happens before
          // transcript append during normal FINALIZE.
          const transcript = await options.sessionManager.read(sessionId);
          return transcript.some((message) => {
            const settlement = message.finalReplySettlement;
            if (message.role !== 'assistant'
              || message.stage !== 'finalize'
              || message.runId !== runId
              || message.sessionId !== String(sessionId)
              || !settlement
              || settlement.settlementId !== reservation.settlementId
              || settlement.reply !== reservation.reply
              || settlement.replyFingerprint !== reservation.replyFingerprint
              || settlement.modelRequestId !== reservation.modelRequestId
              || (settlement.status !== 'proposed' && settlement.status !== 'settled')) {
              return false;
            }
            const text = message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('');
            return text === reservation.reply;
          });
        },
        finalReplyRegistrySettled: async (reservation) => {
          try {
            await options.sessionManager.settleAssistantReplySettlement?.(sessionId, reservation);
            return (await options.sessionManager.assistantReplySettlementStatus?.(
              sessionId,
              reservation.settlementId,
            )) === 'settled';
          } catch {
            return false;
          }
        },
      });
    } finally {
      const releases: Array<Promise<unknown>> = effectClaims.map(({ effectId, ownerToken }) => options.effectLeaseStore.release(
        { sessionId: String(sessionId), runId, effectId }, ownerToken,
      ));
      releases.push(options.leaseStore.release(String(sessionId), runId, acquired.lease.ownerToken!));
      const outcomes = await Promise.allSettled(releases);
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failure) throw failure.reason;
    }
  };
}
