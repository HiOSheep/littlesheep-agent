// @littlesheep/harness — taskbook-skill.ts
//
// The run's task book and plan as a skill body. A task book is per-run content
// that no file on disk can hold, so it is offered as a skill the model loads on
// demand instead of being pushed into every request; the runtime still owns the
// task book object for scheduling, per-step tool enforcement and evidence.
import type { RunContext } from '@littlesheep/types';
import { renderPlanGuidance, renderTaskBookGuidance } from './stages/execute/guidance.js';

export const TASKBOOK_SKILL_NAME = 'taskbook';

export const TASKBOOK_SKILL_DESCRIPTION =
  "This run's task book and plan; load it before working through the steps.";

export function renderTaskbookSkillBody(
  ctx: Pick<RunContext, 'taskBook' | 'plan'>,
): string | undefined {
  const parts: string[] = [];
  if (ctx.taskBook) parts.push(renderTaskBookGuidance(ctx.taskBook));
  if (ctx.plan && ctx.plan.length > 0) parts.push(renderPlanGuidance(ctx.plan));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}