import type { StageResult } from '@littlesheep/types';

/**
 * The smallest stable boundary around a Runner run.  The callbacks keep
 * domain-specific work in runner.ts while this coordinator makes the order
 * and data hand-off explicit and testable.
 */
export interface PreparedRunnerRun<TContext> {
  ctx: TContext;
  sessionId: string;
  inboundText: string;
  usedContinuitySummaryId?: string;
}

export interface ExecutedRunnerRun<TContext, TMemoryAccess = unknown> {
  prepared: PreparedRunnerRun<TContext>;
  stageResult: StageResult;
  memoryAccess?: TMemoryAccess;
  runStopped: boolean;
  runCheckpointId?: string;
}

export interface FinalizedRunnerRun<TContext, TResult, TMemoryAccess = unknown>
  extends ExecutedRunnerRun<TContext, TMemoryAccess> {
  result: TResult;
}

export interface RunnerCoordinator<TContext, TResult, TMemoryAccess = unknown> {
  prepare(): Promise<PreparedRunnerRun<TContext>>;
  execute(prepared: PreparedRunnerRun<TContext>): Promise<ExecutedRunnerRun<TContext, TMemoryAccess>>;
  finalize(executed: ExecutedRunnerRun<TContext, TMemoryAccess>): Promise<FinalizedRunnerRun<TContext, TResult, TMemoryAccess>>;
  persist(finalized: FinalizedRunnerRun<TContext, TResult, TMemoryAccess>): Promise<void>;
}

/** Run the four durable phases in their required order. */
export async function runRunnerCoordinator<TContext, TResult, TMemoryAccess = unknown>(
  coordinator: RunnerCoordinator<TContext, TResult, TMemoryAccess>,
): Promise<TResult> {
  const prepared = await coordinator.prepare();
  const executed = await coordinator.execute(prepared);
  const finalized = await coordinator.finalize(executed);
  await coordinator.persist(finalized);
  return finalized.result;
}
