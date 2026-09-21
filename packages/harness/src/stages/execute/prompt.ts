import {
  assembleSystemPromptBundle,
  resolvePromptConfig,
  type SystemPromptBundle,
} from '@littlesheep/prompt';
import type { RunContext } from '@littlesheep/types';
import {
  appendSystemPromptBundleAddons,
} from '../../profile-prompt.js';
import type { ExecuteStageDeps } from './contracts.js';
import { renderRetrievalIntentContract } from '../../retrieval-intent.js';

/**
 * One prompt shape for the single main loop.
 *
 * The old compact read-only projection (a second, smaller 'respond'-mode prompt
 * for a single-step TaskBook) is gone with the TaskBook step executor: it could
 * only trigger for a one-step plan, and plans are no longer created. Keeping one
 * shape is also what lets a session reuse its cached prefix across turns.
 */
export async function buildExecuteSystemPrompt(
  deps: ExecuteStageDeps,
  ctx: RunContext,
): Promise<SystemPromptBundle> {
  const resolved = resolvePromptConfig(deps.config, deps.branding);
  const base = await assembleSystemPromptBundle(resolved, {
    // The capability summary names the registered catalog, which is what the
    // model is shown; a per-turn restriction travels as the retrieval contract
    // below the cache boundary instead of changing the fixed prompt.
    tools: ctx.tools,
    bootstrap: ctx.bootstrap ?? {},
    prelude: ctx.prelude,
    sessionSummary: ctx.sessionSummary,
    memoryRootIndex: ctx.memoryRootIndex,
    initialMemoryContext: ctx.initialMemoryContext,
    // The tool loop advertises these schemas natively and the runtime enforces the
    // callable set, so the rendered copy is omitted to keep the prompt smaller.
    includeToolingText: false,
  });

  return appendSystemPromptBundleAddons(base, [
    {
      id: 'retrieval-intent-contract',
      text: renderRetrievalIntentContract(ctx),
      kind: 'workflow_state' as const,
      source: { kind: 'workflow' as const, id: 'retrieval-intent-contract', runId: ctx.runId },
      // The main loop's append-only tail owns this section: it is emitted once,
      // in the position it keeps for the rest of the run, instead of being
      // folded into the system message or re-appended per request.
      appendOnly: true,
    },
    { id: 'profile', text: ctx.profilePromptAddon, placement: 'stable' },
    { id: 'reasoning', text: ctx.reasoningPromptAddon, placement: 'stable' },
  ]);
}
