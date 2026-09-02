import type { RunContext, StageResult } from '@littlesheep/types';
import type { RunCheckpointStore } from './run-checkpoint-store.js';
import { buildRunCheckpoint, shouldPersistRunCheckpoint } from './run-checkpoint.js';
import { recordFailure } from '@littlesheep/harness';
import { durableTextDigest } from './durable-run-recorder.js';

export interface ExecuteRunnerPhaseOptions {
  ctx: RunContext;
  harness: { run(ctx: RunContext): Promise<StageResult> };
  signal?: AbortSignal;
  runCheckpointStore?: RunCheckpointStore;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  checkpointReason: (ctx: RunContext, stageResult: StageResult, interrupted: boolean) => string;
  onCheckpointId: (id: string) => void;
}

export interface ExecuteRunnerPhaseResult {
  stageResult: StageResult;
  runInterrupted: boolean;
  runStopped: boolean;
}

/** Execute the harness and persist a durable runtime checkpoint when needed. */
export async function executeRunnerPhase(options: ExecuteRunnerPhaseOptions): Promise<ExecuteRunnerPhaseResult> {
  let stageResult: StageResult;
  try {
    stageResult = await options.harness.run(options.ctx);
  } catch (err) {
    stageResult = {
      stage: 'execute',
      next: 'exit',
      ok: false,
      error: `harness threw: ${(err as Error).message}`,
    };
  }

  const runInterrupted = options.signal?.aborted === true || options.ctx.runtimeControl?.state === 'interrupted';
  const runStopped = runInterrupted || options.ctx.runtimeControl?.state === 'paused';
  if (options.runCheckpointStore && shouldPersistRunCheckpoint(options.ctx, stageResult, runInterrupted)) {
    try {
      const checkpoint = buildRunCheckpoint({
        ctx: options.ctx,
        stageResult,
        interrupted: runInterrupted,
        reason: options.checkpointReason(options.ctx, stageResult, runInterrupted),
      });
      const outcome = await options.runCheckpointStore.write(checkpoint);
      if (outcome.kind === 'conflict') {
        throw new Error(`run checkpoint id conflict: ${outcome.checkpointId}`);
      }
      options.onCheckpointId(checkpoint.id);
      const checkpointReason = options.checkpointReason(options.ctx, stageResult, runInterrupted);
      void options.ctx.appendDurableEvent?.({
        type: 'checkpoint_written',
        source: 'runtime',
        eventId: `${options.ctx.runId}:checkpoint:${checkpoint.id}`,
        idempotencyKey: `${options.ctx.runId}:checkpoint:${checkpoint.id}`,
        payload: {
          checkpointId: checkpoint.id,
          stage: checkpoint.currentStage,
          status: checkpoint.status,
          reasonHash: durableTextDigest(checkpointReason),
          reasonLength: checkpointReason.length,
        },
      }).catch(() => undefined);
    } catch (error) {
      const message = `run checkpoint persistence failed: ${(error as Error).message}`;
      options.log?.('error', `runner: ${message}`);
      recordFailure(options.ctx, 'post-run', stageResult.stage, message);
      stageResult = {
        ...stageResult,
        ok: false,
        error: stageResult.error ? `${stageResult.error}; ${message}` : message,
      };
    }
  }

  return { stageResult, runInterrupted, runStopped };
}
