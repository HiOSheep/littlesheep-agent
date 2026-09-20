// Independent next-Harness driver.
//
// The stage implementations remain shared with the legacy path, but this
// driver owns its own transition loop and records every executed transition in
// the durable event stream. It never emits a second user-facing message or
// invokes a second tool/model call.
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
 * Build the independent durable transition driver. The durable event sink is
 * supplied on RunContext by Runner and is the only persistence boundary here.
 */
export function createNextHarness(opts: DefaultHarnessOptions): AgentHarness {
  const hooks = new HookRunner(opts.log);
  const stages = createHarnessStages(opts);

  return {
    name: 'durable-core-flow',

    async run(ctx: RunContext): Promise<StageResult> {
      bindExactContextTokenCounter(ctx, opts.tokenCounter);
      let current: StageName | 'exit' = resolveCheckpointResumeStage(ctx, ctx.entryStage ?? 'enter');
      const trace: Array<{ name: StageName; startedAt: string; endedAt: string; ok: boolean }> = [];
      let attempt = 0;
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
        if (runtimeTasks.shouldReplan && stageName !== 'decide') {
          current = ctx.classification ? 'decide' : 'classify';
          continue;
        }
        if (runtimeTasks.taskBookChanged && stageName !== 'execute' && !runtimeTasks.shouldReplan) {
          current = ctx.taskBook ? 'execute' : 'decide';
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
