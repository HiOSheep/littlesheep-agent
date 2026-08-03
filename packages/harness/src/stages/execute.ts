// EXECUTE orchestration facade over tool-loop and TaskBook runners.
import type { RunContext, StageResult } from '@littlesheep/types';
import type { ExecuteStageDeps } from './execute/contracts.js';
import { buildExecuteSystemPrompt } from './execute/prompt.js';
import { executeLegacyLoop, executeTaskBook } from './execute/runners.js';
export type { ExecuteStageDeps } from './execute/contracts.js';
export { convertToolCall } from './execute/tool-loop.js';
export function createExecuteStage(deps: ExecuteStageDeps) {
  return async function executeStage(ctx: RunContext): Promise<StageResult> {
    ctx.reply = undefined;
    ctx.replyProvenance = undefined;
    const systemPrompt = await buildExecuteSystemPrompt(deps, ctx);
    const sanitizeOpts = {
      maxOutputChars: deps.config.tools.maxOutputChars,
      stripImages: deps.config.tools.stripImages,
    };
    if (ctx.taskBook && ctx.taskBook.steps.length > 0) return executeTaskBook(deps, ctx, systemPrompt, ctx.taskBook, sanitizeOpts);
    return executeLegacyLoop(deps, ctx, systemPrompt, sanitizeOpts);
  };
}
