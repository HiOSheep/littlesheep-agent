// EXECUTE orchestration facade over tool-loop and TaskBook runners.
import type { RunContext, StageResult } from '@littlesheep/types';
import type { ExecuteStageDeps } from './execute/contracts.js';
import { buildExecuteSystemPrompt } from './execute/prompt.js';
import { emitSystemPromptTranscript } from '../system-prompt-transcript.js';
import { executeLegacyLoop, executeTaskBook } from './execute/runners.js';
import { clearReplyState } from '../reply-state.js';
export type { ExecuteStageDeps } from './execute/contracts.js';
export { convertToolCall } from './execute/tool-loop.js';
export function createExecuteStage(deps: ExecuteStageDeps) {
  return async function executeStage(ctx: RunContext): Promise<StageResult> {
    clearReplyState(ctx, 'execute');
    const systemPrompt = await buildExecuteSystemPrompt(deps, ctx);
    // Same row as the direct-answer path, and only once per run.
    emitSystemPromptTranscript(ctx, systemPrompt.text);
    const sanitizeOpts = {
      maxOutputChars: deps.config.tools.maxOutputChars,
      stripImages: deps.config.tools.stripImages,
    };
    if (ctx.taskBook && ctx.taskBook.steps.length > 0) return executeTaskBook(deps, ctx, systemPrompt, ctx.taskBook, sanitizeOpts);
    return executeLegacyLoop(deps, ctx, systemPrompt, sanitizeOpts);
  };
}
