import type { ChatResponse, ChatTransportMetrics } from '@littlesheep/llm';
import type { RunContext, RunUsage } from '@littlesheep/types';
import {
  assertRunContextFieldWriteAllowed,
  type RunContextContractStage,
} from '@littlesheep/types';

/** RunContext usage snapshot owned by the model-observability boundary. */
export interface UsageStateUpdate {
  usage?: RunUsage;
}

export interface ProviderUsageAcceptanceState {
  providerUsageObserved?: boolean;
  providerUsageFingerprint?: string;
}

export function providerTransportProjection(
  timing: ChatTransportMetrics | ChatResponse['usage'] | undefined,
): Partial<ChatTransportMetrics> {
  if (!timing) return {};
  return {
    ...(timing.durationMs === undefined ? {} : { durationMs: timing.durationMs }),
    ...(timing.requestElapsedMs === undefined ? {} : { requestElapsedMs: timing.requestElapsedMs }),
    ...(timing.transportAttempt === undefined ? {} : { transportAttempt: timing.transportAttempt }),
    ...(timing.observedAttemptCount === undefined ? {} : { observedAttemptCount: timing.observedAttemptCount }),
    ...(timing.ttftMs === undefined ? {} : { ttftMs: timing.ttftMs }),
    ...(timing.contentTtftMs === undefined ? {} : { contentTtftMs: timing.contentTtftMs }),
    ...(timing.reasoningTtftMs === undefined ? {} : { reasoningTtftMs: timing.reasoningTtftMs }),
    ...(timing.toolArgumentsTtftMs === undefined ? {} : { toolArgumentsTtftMs: timing.toolArgumentsTtftMs }),
  };
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

/** Normalize and accumulate one Provider response at the RunContext boundary. */
export function writeProviderUsageState(
  ctx: RunContext,
  stage: RunContextContractStage,
  usage: ChatResponse['usage'] | undefined,
): void {
  const previous = ctx.usage;
  const requestCount = (previous?.requestCount ?? 0) + 1;
  const usageReportedRequestCount = (previous?.usageReportedRequestCount ?? (previous ? previous.requestCount ?? 1 : 0))
    + (usage ? 1 : 0);
  if (!usage) {
    writeUsageState(ctx, stage, {
      usage: {
        promptTokens: previous?.promptTokens ?? 0,
        completionTokens: previous?.completionTokens ?? 0,
        totalTokens: previous?.totalTokens ?? 0,
        ...(previous?.cachedPromptTokens === undefined ? {} : { cachedPromptTokens: previous.cachedPromptTokens }),
        ...(previous?.uncachedPromptTokens === undefined ? {} : { uncachedPromptTokens: previous.uncachedPromptTokens }),
        ...(previous?.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: previous.cacheWriteTokens }),
        ...(previous?.reasoningTokens === undefined ? {} : { reasoningTokens: previous.reasoningTokens }),
        ...(previous?.providerDurationMs === undefined ? {} : { providerDurationMs: previous.providerDurationMs }),
        ...(previous?.observedAttemptCount === undefined ? {} : { observedAttemptCount: previous.observedAttemptCount }),
        timedRequestCount: previous?.timedRequestCount ?? 0,
        timedCompletionTokens: previous?.timedCompletionTokens ?? 0,
        cacheReportedRequestCount: previous?.cacheReportedRequestCount ?? 0,
        usageReportedRequestCount,
        usageCompleteness: usageReportedRequestCount === 0 ? 'unknown' : 'partial',
        requestCount,
        source: 'provider',
      },
    });
    return;
  }
  const timed = usage.durationMs !== undefined;
  const cachedReported = usage.cachedPromptTokens !== undefined;
  const previousCacheReported = previous?.cacheReportedRequestCount ?? (previous?.cachedPromptTokens === undefined ? 0 : 1);
  writeUsageState(ctx, stage, {
    usage: {
      promptTokens: (previous?.promptTokens ?? 0) + usage.promptTokens,
      completionTokens: (previous?.completionTokens ?? 0) + usage.completionTokens,
      totalTokens: (previous?.totalTokens ?? 0) + (usage.totalTokens ?? usage.promptTokens + usage.completionTokens),
      ...sumOptional(previous?.cachedPromptTokens, usage.cachedPromptTokens, 'cachedPromptTokens'),
      ...sumOptional(previous?.uncachedPromptTokens, usage.uncachedPromptTokens, 'uncachedPromptTokens'),
      ...sumOptional(previous?.cacheWriteTokens, usage.cacheWriteTokens, 'cacheWriteTokens'),
      ...sumOptional(previous?.reasoningTokens, usage.reasoningTokens, 'reasoningTokens'),
      ...sumOptional(previous?.providerDurationMs, usage.durationMs, 'providerDurationMs'),
      ...sumOptional(previous?.observedAttemptCount, usage.observedAttemptCount, 'observedAttemptCount'),
      timedRequestCount: (previous?.timedRequestCount ?? 0) + (timed ? 1 : 0),
      timedCompletionTokens: (previous?.timedCompletionTokens ?? 0) + (timed ? usage.completionTokens : 0),
      cacheReportedRequestCount: previousCacheReported + (cachedReported ? 1 : 0),
      usageReportedRequestCount,
      usageCompleteness: usageReportedRequestCount === requestCount ? 'complete' : 'partial',
      requestCount,
      source: 'provider',
    },
  });
}

/** Keep known totals but prevent a conflicting duplicate callback from looking complete. */
export function markProviderUsageStateIncomplete(
  ctx: RunContext,
  stage: RunContextContractStage,
): void {
  const previous = ctx.usage;
  if (!previous) return;
  writeUsageState(ctx, stage, {
    usage: {
      ...previous,
      usageCompleteness: (previous.usageReportedRequestCount ?? 0) > 0 ? 'partial' : 'unknown',
    },
  });
}

/** Deduplicate repeated response callbacks before they reach the run aggregate. */
export function acceptProviderUsageState(
  ctx: RunContext,
  stage: RunContextContractStage,
  state: ProviderUsageAcceptanceState,
  usage: ChatResponse['usage'] | undefined,
): boolean {
  const fingerprint = providerUsageFingerprint(usage);
  if (state.providerUsageObserved) {
    if (state.providerUsageFingerprint !== fingerprint) markProviderUsageStateIncomplete(ctx, stage);
    return false;
  }
  state.providerUsageObserved = true;
  state.providerUsageFingerprint = fingerprint;
  writeProviderUsageState(ctx, stage, usage);
  return true;
}

function providerUsageFingerprint(usage: ChatResponse['usage'] | undefined): string {
  if (!usage) return 'unavailable';
  return JSON.stringify([
    usage.promptTokens, usage.completionTokens, usage.totalTokens,
    usage.cachedPromptTokens, usage.uncachedPromptTokens, usage.cacheWriteTokens, usage.reasoningTokens,
    usage.durationMs, usage.requestElapsedMs, usage.transportAttempt,
    usage.observedAttemptCount, usage.ttftMs,
    usage.contentTtftMs, usage.reasoningTtftMs, usage.toolArgumentsTtftMs,
  ]);
}

function sumOptional<K extends 'cachedPromptTokens' | 'uncachedPromptTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'providerDurationMs' | 'observedAttemptCount'>(
  previous: number | undefined,
  current: number | undefined,
  key: K,
): Partial<Record<K, number>> {
  return previous === undefined && current === undefined
    ? {}
    : { [key]: (previous ?? 0) + (current ?? 0) } as Partial<Record<K, number>>;
}
