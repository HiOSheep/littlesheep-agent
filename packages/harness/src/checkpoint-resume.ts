// Normalizes only checkpoint states whose completed TaskBook evidence is
// independently present. Incomplete or ambiguous resumes keep their stage.

import type { RunContext, StageName } from '@littlesheep/types';

const REPLY_FIRST_STAGES = new Set<StageName>(['ask_user', 'recover', 'verify', 'finalize']);

export function resolveCheckpointResumeStage(
  ctx: RunContext,
  current: StageName | 'exit',
): StageName | 'exit' {
  if (!ctx.resumedFromCheckpointId || current === 'exit') return current;

  // A checkpoint written before the second executor was deleted may name DECIDE
  // as its entry stage. Its TaskBook is read-only history now, so the resume
  // continues in the one main loop instead of re-planning.
  if (current === 'decide') return 'execute';

  if (hasCompletedCheckpointTask(ctx)) {
    if (ctx.taskExecution && ctx.taskExecution.status !== 'done') {
      ctx.taskExecution.status = 'done';
    }
    if (!ctx.reply?.trim() && REPLY_FIRST_STAGES.has(current)) return 'reply';
  }

  return current === 'finalize' && !ctx.reply?.trim() ? 'reply' : current;
}

function hasCompletedCheckpointTask(ctx: RunContext): boolean {
  const planned = ctx.taskBook?.steps ?? [];
  const executed = ctx.taskExecution?.steps ?? [];
  if (planned.length === 0 || executed.length < planned.length) return false;
  const byId = new Map(executed.map((step) => [step.stepId, step]));
  return planned.every((step) => {
    if (!step.id) return false;
    const result = byId.get(step.id);
    return result?.status === 'done' && !result.error;
  });
}
