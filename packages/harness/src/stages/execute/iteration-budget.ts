// The main loop's iteration budget, and what a spent budget means.
//
// The budget is persisted on the run (`loopBudget.toolLoopIterationsUsed`), so it
// survives recovery and checkpoint resumes: a retried stage cannot get a fresh
// allowance. That is why a spent budget used to end the whole turn — RECOVER
// could only escalate it, and the user got a question even when the work was on
// disk.
//
// It now ends the *loop* instead of the turn: one bounded final-answer request is
// allowed, with the tool catalog still advertised and every call refused locally
// (the same mechanism the no-progress bound uses). The budget still bounds the
// loop — a second attempt to cross it fails the stage as before — it just no
// longer discards the answer the model was about to write.
import type { RunContext } from '@littlesheep/types';
import { writeRuntimeState } from '../../runtime-state.js';

export const MAX_TOOL_LOOP_ITERATIONS = 20;
export const MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS = 2;

/** Reserve one iteration, or report that the run's budget is spent. */
export function reserveToolLoopIteration(ctx: RunContext): boolean {
  const current = ctx.loopBudget?.toolLoopIterationsUsed ?? 0;
  const maximum = ctx.loopBudget?.maxToolLoopIterations ?? MAX_TOOL_LOOP_ITERATIONS;
  if (current >= maximum) return false;
  writeRuntimeState(ctx, 'execute', {
    loopBudget: {
      ...(ctx.loopBudget ?? {
        attemptsUsed: ctx.modelCallCount ?? 0,
        maxAttempts: ctx.maxModelCalls ?? 0,
        elapsedMs: 0,
        maxElapsedMs: 0,
        noProgressRounds: 0,
        maxNoProgressRounds: MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS,
      }),
      toolLoopIterationsUsed: current + 1,
      maxToolLoopIterations: maximum,
    },
  });
  return true;
}

export type SpentBudgetDecision =
  /** Spend the one allowed final-answer request; `controlMessage` tells the model. */
  | { kind: 'final-answer'; controlMessage: string }
  /** Fail the stage with the budget error, as every second attempt does. */
  | { kind: 'fail'; error: string };

/**
 * What to do when the budget check fails.
 *
 * A run that produced no tool result has nothing to report, so it fails
 * immediately without spending a request — the case a resumed run hits when it
 * enters already exhausted.
 */
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
