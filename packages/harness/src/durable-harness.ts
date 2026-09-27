// The one Core Flow driver.
//
// The stage implementations come from the shared stage factory, but this driver
// owns its own transition loop and records every executed transition in the
// durable event stream. It never emits a second user-facing message or invokes a
// second tool/model call.
import type {
  AgentHarness,
  AnyHook,
  RunContext,
  Stage,
  StageName,
  StageResult,
} from '@littlesheep/types';
import { inspectStageTransition, stageNames } from '@littlesheep/types';
import { HookRunner } from './hooks/runner.js';
import {
  createHarnessStages,
  type DefaultHarnessOptions,
} from './default-harness.js';
import { consumeRuntimeControlEvents, consumeRuntimeTaskEvents } from './runtime-control-boundary.js';
import { bindExactContextTokenCounter } from './model-observability.js';
import { resolveCheckpointResumeStage } from './checkpoint-resume.js';
import { recordFailure } from './failure-state.js';

/**
 * Build the durable transition driver — the one Core Flow driver. It is reached through
 * createDefaultHarness, which supplies the stage registry; the durable event sink arrives on RunContext
 * and is the only persistence boundary here.
 */
export function createDurableHarness(opts: DefaultHarnessOptions): AgentHarness {
  const hooks = new HookRunner(opts.log);
  const stages = createHarnessStages(opts);

  return {
    name: 'durable-core-flow',

    async run(ctx: RunContext): Promise<StageResult> {
      bindExactContextTokenCounter(ctx, opts.tokenCounter);
      let current: StageName | 'exit' = resolveCheckpointResumeStage(ctx, ctx.entryStage ?? 'enter');
      const trace: Array<{ name: StageName; startedAt: string; endedAt: string; ok: boolean }> = [];
      let attempt = 0;
      /** Runtime events already handed to the main loop once; see the re-entry bounds below. */
      const deliveredRuntimeEventIds = new Set<string>();
      let lastResult: StageResult = {
        stage: 'enter',
        next: 'exit',
        ok: false,
        error: 'no stage executed',
      };

      while (current !== 'exit') {
        current = resolveCheckpointResumeStage(ctx, current);
        const stageName = current as StageName;
        const stage = stages.get(stageName);
        const startedAt = new Date().toISOString();
        attempt += 1;

        if (!stage) {
          const result: StageResult = {
            stage: stageName,
            next: 'exit',
            ok: false,
            error: `no stage registered for '${stageName}'`,
            meta: { trace },
          };
          await recordTransition(ctx, stageName, result, attempt);
          return result;
        }

        const runtimeControl = consumeRuntimeControlEvents(ctx);
        if (runtimeControl.shouldStop) {
          const endedAt = new Date().toISOString();
          const error = runtimeControl.error
            ?? (runtimeControl.state === 'paused'
              ? 'run paused at a safe boundary'
              : 'run interrupted at a safe boundary');
          const result: StageResult = {
            stage: stageName,
            next: 'exit',
            ok: false,
            error,
            meta: {
              runtimeControl: ctx.runtimeControl,
              runtimeEventIds: runtimeControl.settledEventIds,
            },
          };
          trace.push({ name: stageName, startedAt, endedAt, ok: false });
          recordFailure(ctx, stageName, stageName, error);
          await recordTransition(ctx, stageName, result, attempt);
          lastResult = result;
          current = 'exit';
          continue;
        }

        const runtimeTasks = consumeRuntimeTaskEvents(ctx);
        if (runtimeTasks.error) {
          const endedAt = new Date().toISOString();
          const error = runtimeTasks.error;
          const result: StageResult = {
            stage: stageName,
            next: 'exit',
            ok: false,
            error,
            meta: {
              runtimeEventIds: runtimeTasks.settledEventIds,
              deferredRuntimeEventIds: runtimeTasks.deferredEventIds,
              appliedTaskBookPatchIds: runtimeTasks.appliedPatchIds,
            },
          };
          trace.push({ name: stageName, startedAt, endedAt, ok: false });
          recordFailure(ctx, stageName, stageName, error);
          await recordTransition(ctx, stageName, result, attempt);
          lastResult = result;
          current = 'exit';
          continue;
        }
        // Same boundary as the default driver: a queued runtime task event
        // re-enters the single main loop, not the deleted planner.
        //
        // Each hand-off happens once per event. The main loop is where a deferred event is consumed, and if
        // it routes somewhere else while the event is still deferred, that decision is the answer: bouncing
        // every other stage back into `execute` for an event nobody consumes is an unbounded loop, which is
        // exactly what this used to do (measured before the bound: a stage that never consumes the event
        // never let the run end, and the harness test spun until the worker ran out of memory).
        const claimedRuntimeEventIds = [...runtimeTasks.settledEventIds, ...runtimeTasks.deferredEventIds];
        const undeliveredReplan = runtimeTasks.shouldReplan
          && claimedRuntimeEventIds.some((id) => !deliveredRuntimeEventIds.has(id));
        if (undeliveredReplan && stageName !== 'execute') {
          for (const id of claimedRuntimeEventIds) deliveredRuntimeEventIds.add(id);
          current = ctx.classification ? 'execute' : 'classify';
          continue;
        }
        // A user update captured before CLASSIFY still belongs to the active
        // run. Once route facts exist, deliver it through the single EXECUTE
        // loop even if the original turn would otherwise have taken REPLY.
        const deferredUserMessages = (ctx.deferredRuntimeEvents ?? []).filter((event) => (
          event.type === 'user_message' && typeof event.payload.text === 'string'
        ));
        const undeliveredUserMessages = deferredUserMessages
          .filter((event) => !deliveredRuntimeEventIds.has(event.id));
        if (undeliveredUserMessages.length > 0 && stageName !== 'execute' && stageName !== 'classify') {
          for (const event of undeliveredUserMessages) deliveredRuntimeEventIds.add(event.id);
          current = ctx.classification ? 'execute' : 'classify';
          continue;
        }
        if (runtimeTasks.taskBookChanged
          && stageName !== 'execute'
          && !runtimeTasks.shouldReplan
          && claimedRuntimeEventIds.some((id) => !deliveredRuntimeEventIds.has(id))) {
          for (const id of claimedRuntimeEventIds) deliveredRuntimeEventIds.add(id);
          current = ctx.classification ? 'execute' : 'classify';
          continue;
        }

        const before = await hooks.runBefore(ctx, stageName);
        let result: StageResult;
        if (before.claimed) {
          result = before.claimed;
        } else {
          try {
            result = await stage(ctx);
          } catch (error) {
            result = {
              stage: stageName,
              next: 'exit',
              ok: false,
              error: `stage threw: ${(error as Error).message}`,
            };
          }
        }

        result = await hooks.runAfter(ctx, stageName, result);
        result = { ...result, stage: stageName };
        const transition = inspectStageTransition(stageName, result.next);
        if (!transition.ok) {
          const attempted = String(transition.violation.attempted);
          const allowed = transition.violation.allowed;
          result = {
            stage: stageName,
            next: 'exit',
            ok: false,
            error: `invalid stage transition '${stageName}' -> '${attempted}'; allowed targets: ${allowed.join(', ')}`,
            meta: {
              ...(result.meta ?? {}),
              transitionViolation: {
                from: stageName,
                attempted: transition.ok ? result.next : transition.violation.attempted,
                allowed,
              },
            },
          };
        }

        const endedAt = new Date().toISOString();
        trace.push({ name: stageName, startedAt, endedAt, ok: result.ok });
        if (!result.ok && result.error && (!ctx.lastError || ctx.lastError.stage !== stageName)) {
          recordFailure(ctx, stageName, stageName, result.error);
        }
        await recordTransition(ctx, stageName, result, attempt);
        lastResult = result;
        current = result.next;
      }

      return {
        ...lastResult,
        next: 'exit',
        meta: { ...(lastResult.meta ?? {}), trace },
      };
    },

    on(hook: AnyHook): void {
      hooks.register(hook);
    },

    registerStage(name: StageName, stage: Stage): void {
      if (!stageNames.includes(name)) {
        throw new Error(`registerStage: unknown stage '${name}'`);
      }
      stages.set(name, stage);
    },
  };
}
async function recordTransition(
  ctx: RunContext,
  stage: StageName,
  result: StageResult,
  attempt: number,
): Promise<void> {
  await ctx.appendDurableEvent?.({
    type: 'stage_transition_recorded',
    source: 'runtime',
    eventId: `${ctx.runId}:stage-transition:${attempt}`,
    idempotencyKey: `${ctx.runId}:stage-transition:${attempt}`,
    payload: {
      stage,
      next: result.next,
      ok: result.ok,
      attempt,
    },
  });
}
