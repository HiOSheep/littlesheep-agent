// Physical Provider response accounting precedes semantic reply/tool validation.
import type { ProviderResponseReceipt, ChatTransportMetrics, ChatResponse } from '@littlesheep/llm';
import type { ModelRequestSnapshot, RunContext } from '@littlesheep/types';
import { classifyProviderCacheUsage } from './cache-observability.js';
import { writeProviderUsageState, writeUsageState } from './usage-state.js';

export interface ProviderReceiptAccounting {
  receipts?: Map<number, Promise<void>>;
  receiptObservedAttempts?: number;
}

export async function acceptProviderReceipt(ctx: RunContext, snapshot: ModelRequestSnapshot,
  state: ProviderReceiptAccounting, receipt: ProviderResponseReceipt): Promise<void> {
  state.receipts ??= new Map();
  let persisted = state.receipts.get(receipt.attempt);
  if (!persisted) {
    persisted = persistProviderReceipt(ctx, snapshot, receipt).then(observed => {
      state.receiptObservedAttempts = (state.receiptObservedAttempts ?? 0) + observed;
    });
    state.receipts.set(receipt.attempt, persisted);
  }
  await persisted;
}

export function completeProviderTransportAccounting(ctx: RunContext, snapshot: ModelRequestSnapshot,
  state: ProviderReceiptAccounting, timing: ChatTransportMetrics | ChatResponse['usage']): void {
  if (!state.receipts?.size || !ctx.usage) return;
  const uncounted = (timing?.observedAttemptCount ?? 0) - (state.receiptObservedAttempts ?? 0);
  if (uncounted <= 0) return;
  writeUsageState(ctx, snapshot.stage, { usage: { ...ctx.usage,
    observedAttemptCount: (ctx.usage.observedAttemptCount ?? 0) + uncounted } });
  state.receiptObservedAttempts = timing!.observedAttemptCount;
}

export async function persistProviderReceipt(
  ctx: RunContext,
  snapshot: ModelRequestSnapshot,
  receipt: ProviderResponseReceipt,
): Promise<number> {
  const classified = classifyProviderCacheUsage(receipt.usage);
  const usage = classified.validUsage;
  await ctx.appendDurableEvent?.({
    type: 'provider_usage_recorded', source: 'runtime',
    eventId: `${ctx.runId}:provider-usage:${snapshot.id}:${receipt.attempt}`,
    idempotencyKey: `${ctx.runId}:provider-usage:${snapshot.id}:${receipt.attempt}`,
    payload: {
      requestId: snapshot.id, attempt: receipt.attempt, completed: receipt.completed,
      provider: snapshot.provider, model: snapshot.model,
      usageStatus: usage ? 'available' : 'unavailable',
      ...(usage ? { ...Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)),
        cacheStatus: classified.ledger.status, reconciliation: 'unavailable' } : {
        reason: classified.reason ?? 'provider_usage_missing',
      }),
    },
  });
  if (usage || receipt.completed) {
    writeProviderUsageState(ctx, snapshot.stage, usage ? { ...receipt.usage, ...usage } : undefined);
  }
  return usage ? receipt.usage?.observedAttemptCount ?? 0 : 0;
}
