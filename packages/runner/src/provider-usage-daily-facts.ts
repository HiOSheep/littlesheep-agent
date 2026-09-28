// Reads Provider usage facts out of persisted durable run events (O5).
//
// The durable event log is the only authority here: a counted attempt is one
// `model_response_received` event whose payload carries a Provider-reported
// usage projection. The same reducer the Harness kernel uses replays the run, so
// a malformed log fails closed instead of being partially believed, and a
// response that carried no usable usage becomes an explicit missing-coverage
// mark rather than a zero.
import type { DurableHarnessEvent, DurableRunProjection } from '@littlesheep/types';
import { reduceDurableRunProjection } from '@littlesheep/harness';

export const PROVIDER_USAGE_FACTS_VERSION = 1 as const;

/** One deduplicatable Provider attempt: identity, usage-event time, usage. */
export interface ProviderUsageAttemptFact {
  readonly requestId: string;
  /** `model_response_received` event time: when the usage report was recorded. */
  readonly at: string;
  readonly provider: string;
  readonly model: string;
  readonly total: number;
  readonly input: number;
  readonly output: number;
  /** Subset of `input`; never added to `total`. */
  readonly cached: number;
  /** Subset of `output`; never added to `total`. */
  readonly reasoning: number;
}

/**
 * A request that is known to have happened but has no counted usage:
 * `response_without_usage` reached the Provider and reported nothing usable,
 * `request_without_response` never recorded a response at all.
 */
export interface ProviderUsageMissingFact {
  readonly requestId: string;
  readonly at: string;
  readonly kind: 'response_without_usage' | 'request_without_response';
  readonly provider: string;
  readonly model: string;
}

export interface ProviderUsageRunFacts {
  readonly sessionId: string;
  readonly runId: string;
  readonly mode: 'next' | 'shadow' | 'unknown';
  readonly attempts: readonly ProviderUsageAttemptFact[];
  readonly missing: readonly ProviderUsageMissingFact[];
}

export type ProviderUsageRunFactsRead =
  | { readonly ok: true; readonly facts: ProviderUsageRunFacts }
  | { readonly ok: false; readonly reason: string };

const UNKNOWN_IDENTITY = 'unknown';

/** Reduces one run's durable events into usage facts, or reports why it cannot. */
export function readProviderUsageRunFacts(
  events: readonly DurableHarnessEvent[],
): ProviderUsageRunFactsRead {
  const first = events[0];
  if (!first) return { ok: false, reason: 'empty-run' };
  let projection: DurableRunProjection;
  try {
    projection = reduceDurableRunProjection(events);
  } catch (error) {
    return { ok: false, reason: `unreadable-events: ${(error as Error).message}` };
  }
  const attempts: ProviderUsageAttemptFact[] = [];
  const missing: ProviderUsageMissingFact[] = [];
  for (const request of projection.modelRequests) {
    const provider = boundedIdentity(request.provider);
    const model = boundedIdentity(request.model);
    const usage = request.providerUsage;
    if (usage && request.respondedAt) {
      // Section 2: total prefers the reported total; input + output are only a
      // fallback when that field is absent. Cached and reasoning stay subsets.
      attempts.push({
        requestId: request.requestId,
        at: request.respondedAt,
        provider,
        model,
        total: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
        input: usage.promptTokens,
        output: usage.completionTokens,
        cached: usage.cachedPromptTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
      });
      continue;
    }
    const at = request.respondedAt ?? request.startedAt;
    if (!at) continue;
    missing.push({
      requestId: request.requestId,
      at,
      kind: request.status === 'received' ? 'response_without_usage' : 'request_without_response',
      provider,
      model,
    });
  }
  return {
    ok: true,
    facts: {
      sessionId: first.sessionId,
      runId: first.runId,
      mode: readRunMode(events),
      attempts,
      missing,
    },
  };
}

function readRunMode(events: readonly DurableHarnessEvent[]): 'next' | 'shadow' | 'unknown' {
  const mode = events.find((event) => event.type === 'run_accepted')?.payload['durableHarnessMode'];
  if (mode === 'next' || mode === 'shadow') return mode;
  return 'unknown';
}

function boundedIdentity(value: string | undefined): string {
  if (typeof value !== 'string') return UNKNOWN_IDENTITY;
  const trimmed = value.trim();
  if (!trimmed) return UNKNOWN_IDENTITY;
  return trimmed.length > 128 ? trimmed.slice(0, 128) : trimmed;
}
