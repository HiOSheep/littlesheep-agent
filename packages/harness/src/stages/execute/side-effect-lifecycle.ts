// Adapts the durable side-effect ledger to ToolExecutionService lifecycle hooks.

import type { RunContext } from '@littlesheep/types';
import type { ToolExecutionLifecycle } from '@littlesheep/tools';
import {
  beginSideEffect,
  describeSideEffect,
  finishSideEffect,
  settlementForResult,
  sideEffectCheckpointReason,
} from './side-effect-ledger.js';

export function createSideEffectLifecycle(ctx: RunContext): ToolExecutionLifecycle {
  const effects = new Map<string, ReturnType<typeof describeSideEffect>>();
  return {
    async beforeInvoke(invocation) {
      const sideEffect = describeSideEffect(
        invocation.tool,
        invocation.input,
        invocation.resources,
        invocation.request.stepId,
        invocation.request.callId,
      );
      effects.set(invocation.request.callId, sideEffect);
      if (!sideEffect) return;
      let begin: Awaited<ReturnType<typeof beginSideEffect>>;
      try {
        // Intent must be durable before a write-capable or external invocation.
        begin = await beginSideEffect(ctx, sideEffect);
      } catch (error) {
        return {
          result: {
            callId: invocation.request.callId,
            ok: false,
            error: `refusing effectful tool until its intent is durable: ${(error as Error).message}`,
          },
          status: 'failed',
          errorKind: 'effect_intent_persistence',
        };
      }
      if (begin.kind === 'duplicate' || begin.kind === 'blocked') {
        return {
          result: {
            callId: invocation.request.callId,
            ok: false,
            error: begin.kind === 'duplicate'
              // The refusal names what still works. A repeated opaque command is
              // the exact case the model reaches when it wants a *fresh
              // observation* after writing something; without a next step it
              // retries variations of the same call instead.
              ? `side effect already recorded as succeeded; refusing to replay ${sideEffect.idempotencyKey}. `
                + 'The Runtime never re-runs an opaque command: for a fresh view of the workspace use the '
                + 'read-only tools (`glob` lists a directory, `read` reads a file).'
              : begin.reason,
          },
          status: begin.kind === 'duplicate' ? 'repeated_call_blocked' : 'failed',
          errorKind: begin.kind === 'duplicate' ? 'side_effect_replay' : 'side_effect_blocked',
        };
      }
      // A retry of a settled failure gets its own attempt id, so every later
      // settlement and checkpoint has to use the descriptor that was recorded.
      if (begin.kind === 'none') return;
      effects.set(invocation.request.callId, begin.descriptor);
      const effective = begin.descriptor;
      if (ctx.signal?.aborted) {
        await finishSideEffect(ctx, effective, {
          callId: invocation.request.callId,
          ok: false,
          error: 'run aborted before effect invocation',
        }, true, 'cancelled');
        return {
          result: {
            callId: invocation.request.callId,
            ok: false,
            error: 'run aborted before effect invocation',
          },
          status: 'aborted',
          errorKind: 'run_aborted_before_effect',
        };
      }
      try {
        await ctx.persistRuntimeCheckpoint?.(sideEffectCheckpointReason(effective, 'started'));
      } catch (error) {
        await finishSideEffect(ctx, effective, {
          callId: invocation.request.callId,
          ok: false,
          error: `checkpoint before side effect failed: ${(error as Error).message}`,
        }, true, 'failed');
        return {
          result: {
            callId: invocation.request.callId,
            ok: false,
            error: `refusing effectful tool until its checkpoint is durable: ${(error as Error).message}`,
          },
          status: 'failed',
          errorKind: 'checkpoint_before_effect',
        };
      }
    },
    async afterInvoke(invocation, result, outcome) {
      const sideEffect = effects.get(invocation.request.callId);
      if (!sideEffect) return result;
      try {
        // Settlement precedes the resumability projection, preventing replay. A
        // determinate failure is settled as `failed` so the model can react to a
        // failed command; only a cut-short invocation stays `unknown`.
        await finishSideEffect(ctx, sideEffect, result, true, settlementForResult(result, outcome));
      } catch (error) {
        return {
          result: {
            ...result,
            ok: false,
            error: `side effect result is not durably settled: ${(error as Error).message}`,
          },
          status: 'failed',
          errorKind: 'effect_settlement_persistence',
        };
      }
      try {
        await ctx.persistRuntimeCheckpoint?.(sideEffectCheckpointReason(sideEffect, 'finished'));
        return result;
      } catch (error) {
        return {
          result: {
            ...result,
            ok: false,
            error: `effect completed but checkpoint persistence failed: ${(error as Error).message}`,
            meta: {
              ...(result.meta ?? {}),
              effectSettlement: 'durable',
              checkpointPersistence: 'failed',
            },
          },
          status: 'failed',
          errorKind: 'checkpoint_after_effect',
        };
      }
    },
  };
}
