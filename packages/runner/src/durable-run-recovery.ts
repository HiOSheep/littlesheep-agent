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
        finalReplyPersisted: async (reservation) => (
          await options.sessionManager.assistantReplySettlementStatus?.(sessionId, reservation.settlementId)
        ) === 'settled',
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
