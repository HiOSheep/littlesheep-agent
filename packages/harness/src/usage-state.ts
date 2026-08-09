import type { ChatResponse } from '@littlesheep/llm';
import type { RunContext, RunUsage } from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** RunContext usage snapshot owned by the model-observability boundary. */
export interface UsageStateUpdate {
  usage?: RunUsage;
}

const USAGE_FIELDS = ['usage'] as const satisfies readonly (keyof UsageStateUpdate)[];

/**
 * Commit the latest provider usage only after the current stage is authorized.
 * Request-level usage remains attached to context snapshots separately.
 */
export function writeUsageState(
  ctx: RunContext,
  stage: RunContextContractStage,
  update: UsageStateUpdate,
): void {
  const fields = Object.keys(update) as Array<keyof UsageStateUpdate>;
  for (const field of fields) {
    if (!USAGE_FIELDS.includes(field)) {
      throw new Error(`Unknown usage state field '${String(field)}'.`);
    }
    assertRunContextFieldWriteAllowed(field, stage);
  }
  Object.assign(ctx, update);
}

/** Normalize an LLM response usage payload at the RunContext boundary. */
export function writeProviderUsageState(
  ctx: RunContext,
  stage: RunContextContractStage,
  usage: ChatResponse['usage'] | undefined,
): void {
  if (!usage) return;
  writeUsageState(ctx, stage, {
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
      source: 'provider',
    },
  });
}
