// EXECUTE orchestration facade over tool-loop and TaskBook runners.
import type { RunContext, StageResult } from '@littlesheep/types';
import { assembleSystemPromptBundle, resolvePromptConfig } from '@littlesheep/prompt';
import { appendSystemPromptBundleAddons } from '../profile-prompt.js';
import type { ExecuteStageDeps } from './execute/contracts.js';
import { renderPlanGuidance, renderTaskBookGuidance } from './execute/guidance.js';
import { executeLegacyLoop, executeTaskBook } from './execute/runners.js';

export type { ExecuteStageDeps } from './execute/contracts.js';
export { convertToolCall } from './execute/tool-loop.js';

export function createExecuteStage(deps: ExecuteStageDeps) {
  return async function executeStage(ctx: RunContext): Promise<StageResult> {
    const resolved = resolvePromptConfig(deps.config, deps.branding);
    const baseSystemPrompt = await assembleSystemPromptBundle(resolved, {
      tools: ctx.tools,
      bootstrap: ctx.bootstrap ?? {},
      prelude: ctx.prelude,
      sessionSummary: ctx.sessionSummary,
      memoryRootIndex: ctx.memoryRootIndex,
    });
    const planGuidance = ctx.taskBook
      ? renderTaskBookGuidance(ctx.taskBook)
      : ctx.plan && ctx.plan.length > 0
        ? renderPlanGuidance(ctx.plan)
        : '';
    const systemPrompt = appendSystemPromptBundleAddons(baseSystemPrompt, [
      {
        id: 'execution-plan',
        text: planGuidance,
        kind: 'workflow_state',
        source: { kind: 'workflow', id: 'execution-plan', runId: ctx.runId },
      },
      { id: 'profile', text: ctx.profilePromptAddon },
      { id: 'reasoning', text: ctx.reasoningPromptAddon },
    ]);
    const sanitizeOpts = {
      maxOutputChars: deps.config.tools.maxOutputChars,
      stripImages: deps.config.tools.stripImages,
    };
    if (ctx.taskBook && ctx.taskBook.steps.length > 0) {
      return executeTaskBook(deps, ctx, systemPrompt, ctx.taskBook, sanitizeOpts);
    }
    return executeLegacyLoop(deps, ctx, systemPrompt, sanitizeOpts);
  };
}
