// EXECUTE orchestration facade over the single main loop.
import type { RunContext, StageResult } from '@littlesheep/types';
import type { ExecuteStageDeps } from './execute/contracts.js';
import { buildExecuteSystemPrompt } from './execute/prompt.js';
import { executeLegacyLoop } from './execute/runners.js';
import { clearReplyState } from '../reply-state.js';
export type { ExecuteStageDeps } from './execute/contracts.js';
export { convertToolCall } from './execute/tool-loop.js';
export function createExecuteStage(deps: ExecuteStageDeps) {
  return async function executeStage(ctx: RunContext): Promise<StageResult> {
    clearReplyState(ctx, 'execute');
    const systemPrompt = await buildExecuteSystemPrompt(deps, ctx);
    const sanitizeOpts = {
      maxOutputChars: deps.config.tools.maxOutputChars,
      stripImages: deps.config.tools.stripImages,
    };
    // An already persisted TaskBook is history now: it is read and displayed, and
    // the run's work is done by the same loop as everything else.
    return executeLegacyLoop(deps, ctx, systemPrompt, sanitizeOpts);
  };
}
