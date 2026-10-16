// Segment and Run-wide execution limits. A segment can roll over while its Run
// still has explicit total loop, model-call, and tool-call allowance remaining.
import type { RunContext } from '@littlesheep/types';
import { writeRuntimeState } from '../../runtime-state.js';

export const MAX_TOOL_LOOP_ITERATIONS = 30;
export const MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS = 2;

/** The ceiling this segment actually has: its recorded one, or the Runtime constant. */
export function toolLoopIterationCeiling(ctx: RunContext): number {
  return ctx.loopBudget?.maxToolLoopIterations ?? MAX_TOOL_LOOP_ITERATIONS;
}

export function toolLoopBudgetStop(ctx: RunContext): 'segment' | 'run' | undefined {
  const budget = ctx.loopBudget;
  if ((budget?.toolLoopIterationsUsed ?? 0) >= (budget?.maxToolLoopIterationsPerRun
    ?? budget?.maxToolLoopIterations ?? MAX_TOOL_LOOP_ITERATIONS)) return 'run';
  if ((budget?.segmentIterationsUsed ?? 0) >= toolLoopIterationCeiling(ctx)) return 'segment';
  return undefined;
}

/** Reserve one model/tool-loop turn in both the current segment and its Run. */
export function reserveToolLoopIteration(ctx: RunContext): boolean {
  if (toolLoopBudgetStop(ctx)) return false;
  const budget = ctx.loopBudget;
  const current = budget?.toolLoopIterationsUsed ?? 0;
  const segmentUsed = budget?.segmentIterationsUsed ?? 0;
  const maximum = toolLoopIterationCeiling(ctx);
  writeRuntimeState(ctx, 'execute', {
    loopBudget: {
      ...(budget ?? {
        attemptsUsed: ctx.modelCallCount ?? 0,
        maxAttempts: ctx.maxModelCalls ?? 0,
        elapsedMs: 0,
        maxElapsedMs: 0,
        noProgressRounds: 0,
        maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
      }),
      toolLoopIterationsUsed: current + 1,
      segmentIterationsUsed: segmentUsed + 1,
      executionSegmentIndex: budget?.executionSegmentIndex ?? 1,
      maxToolLoopIterations: maximum,
    },
  });
  return true;
}

/** Start a segment without replenishing any Run-scoped budget or progress state. */
export function beginNextExecutionSegment(ctx: RunContext): void {
  const budget = ctx.loopBudget;
  if (!budget) throw new Error('cannot continue execution without a Run budget snapshot');
  if (toolLoopBudgetStop(ctx) !== 'segment') {
    throw new Error('cannot begin a segment before the current segment reaches its limit');
  }
  writeRuntimeState(ctx, 'execute', {
    loopBudget: {
      ...budget,
      executionSegmentIndex: (budget.executionSegmentIndex ?? 1) + 1,
      segmentIterationsUsed: 0,
    },
  });
}

export type ToolCallReservation = { allowed: true; newlyReserved: number } | { allowed: false; remaining: number };

/** Reserve proposed calls before execution; a repeated request identity is charged once. */
export function reserveToolCalls(ctx: RunContext, requestId: string, callCount: number): ToolCallReservation {
  if (!requestId || !Number.isSafeInteger(callCount) || callCount < 0) {
    throw new Error('tool-call reservation requires a valid request identity and call count');
  }
  const budget = ctx.loopBudget ?? {
    attemptsUsed: ctx.modelCallCount ?? 0,
    maxAttempts: ctx.maxModelCalls ?? 0,
    elapsedMs: 0,
    maxElapsedMs: 0,
    noProgressRounds: 0,
    maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
    toolCallsUsed: 0,
    maxToolCalls: 128,
    toolCallReservationKeys: [],
  };
  const keys = new Set(budget.toolCallReservationKeys ?? []);
  const newKeys = Array.from({ length: callCount }, (_, index) => `${requestId}:${index}`)
    .filter((key) => !keys.has(key));
  const used = budget.toolCallsUsed ?? 0;
  const maximum = budget.maxToolCalls ?? 128;
  if (used + newKeys.length > maximum) return { allowed: false, remaining: Math.max(0, maximum - used) };
  for (const key of newKeys) keys.add(key);
  writeRuntimeState(ctx, 'execute', {
    loopBudget: {
      ...budget,
      toolCallsUsed: used + newKeys.length,
      maxToolCalls: maximum,
      toolCallReservationKeys: [...keys].slice(-maximum),
    },
  });
  return { allowed: true, newlyReserved: newKeys.length };
}

export type SpentBudgetDecision =
  | { kind: 'final-answer'; controlMessage: string }
  | { kind: 'fail'; error: string };

export function decideSpentIterationBudget(options: {
  toolResultCount: number;
  finalAnswerAlreadyRequested: boolean;
  controlMessage: string;
  maxIterations?: number;
}): SpentBudgetDecision {
  const maximum = options.maxIterations ?? MAX_TOOL_LOOP_ITERATIONS;
  const error = `tool loop exceeded the persisted ${maximum}-iteration run budget`;
  if (options.finalAnswerAlreadyRequested || options.toolResultCount === 0) {
    return { kind: 'fail', error };
  }
  return { kind: 'final-answer', controlMessage: options.controlMessage };
}
