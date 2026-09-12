// Durable-path projection of the exact system prompt a run uses.
//
// The user explicitly asked for full disclosure: the prompt (identity,
// SOUL/USER, memory index, contracts) is rendered as a collapsible row. The
// legacy path keeps its previous hidden-prompt behaviour.
import type { RunContext } from '@littlesheep/types';

export function emitSystemPromptTranscript(ctx: RunContext, text: string): void {
  if (ctx.streamModelTranscript !== true || typeof ctx.onToolEvent !== 'function') return;
  if (ctx.systemPromptProjected === true) return;
  ctx.systemPromptProjected = true;
  ctx.systemPromptProjection = text;
  try {
    ctx.onToolEvent({
      type: 'system_prompt',
      visibility: 'progress',
      phaseId: 'system-prompt',
      // This projection intentionally carries the complete effective prompt:
      // the product setting explicitly discloses SOUL, USER and injected
      // memory fragments instead of presenting a misleading partial prompt.
      summary: text,
    });
  } catch {
    // Prompt projection is cosmetic; never fail a run because of it.
  }
}
