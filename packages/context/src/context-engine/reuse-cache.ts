// Content-addressed reuse cache for one ContextEngine instance.
//
// `prepare()` re-derives candidates, evicts optional context and re-runs the
// exact token counter on every request. When the assembly inputs are byte-equal
// to a previous request, the eviction decision, measurement and estimator
// outcome are all reusable — and that reuse is a real local cache event the
// Runtime can report instead of guessing.
import { createHash } from 'node:crypto';
import type { ContextSafetyEstimate } from '@littlesheep/types';
import type { ContextMessageCandidate, PrepareContextRequestInput } from './contracts.js';

export interface ContextReuseEvent {
  readonly status: 'hit' | 'miss';
  readonly reuseKey: string;
  readonly reusedItems: number;
  readonly rebuiltItems: number;
}

export interface ContextReuseEntry {
  readonly key: string;
  readonly omitted: string[];
  readonly measurement: number;
  readonly promptTokens?: number;
  readonly safetyEstimate?: ContextSafetyEstimate;
  readonly counterFailure?: string;
}

const MAX_ENTRIES = 32;

export class ContextReuseCache {
  private readonly entries = new Map<string, ContextReuseEntry>();

  lookup(key: string): ContextReuseEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh recency so a hot key is not evicted by a burst of cold ones.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  store(entry: ContextReuseEntry): void {
    if (this.entries.has(entry.key)) this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface ContextReuseResolution {
  readonly key: string;
  /** Present when an identical earlier assembly may be reused. */
  readonly entry?: ContextReuseEntry;
  readonly event: ContextReuseEvent;
}

/** Decide hit/miss for one assembly without touching the engine's own state. */
export function resolveContextReuse(
  input: PrepareContextRequestInput,
  candidates: readonly ContextMessageCandidate[],
  budget: { provider: string; model: string; targetPromptTokens?: number; availablePromptTokens?: number },
  cache: ContextReuseCache,
): ContextReuseResolution {
  const key = contextReuseKey(input, candidates, budget);
  const entry = cache.lookup(key);
  return {
    key,
    ...(entry ? { entry } : {}),
    event: entry
      ? { status: 'hit', reuseKey: key, reusedItems: candidates.length - entry.omitted.length, rebuiltItems: 0 }
      : { status: 'miss', reuseKey: key, reusedItems: 0, rebuiltItems: candidates.length },
  };
}

/** Persist the outcome of a rebuilt assembly for future identical requests. */
export function storeContextReuse(
  cache: ContextReuseCache,
  resolution: ContextReuseResolution,
  outcome: Omit<ContextReuseEntry, 'key'>,
): void {
  cache.store({ key: resolution.key, ...outcome });
}

/**
 * Fingerprint every input that can change the assembled request or the eviction
 * decision. Candidate order, required flags, segments and the base request are
 * all part of the key, so a hit can only mean an identical assembly.
 */
export function contextReuseKey(
  input: PrepareContextRequestInput,
  candidates: readonly ContextMessageCandidate[],
  budget: { provider: string; model: string; targetPromptTokens?: number; availablePromptTokens?: number },
): string {
  const hash = createHash('sha256');
  hash.update(String(input.stage));
  hash.update('\u0000');
  hash.update(JSON.stringify(input.callContract ?? null));
  hash.update('\u0000');
  hash.update(budget.provider);
  hash.update('\u0000');
  hash.update(budget.model);
  hash.update('\u0000');
  hash.update(String(budget.targetPromptTokens ?? ''));
  hash.update('\u0000');
  hash.update(String(budget.availablePromptTokens ?? ''));
  hash.update('\u0000');
  hash.update(JSON.stringify(input.request));
  hash.update('\u0000');
  hash.update(JSON.stringify(candidates.map((candidate) => ({
    id: candidate.id,
    order: candidate.order,
    required: candidate.required,
    priority: candidate.priority,
    evictionGroup: candidate.evictionGroup ?? null,
    message: candidate.message,
    segments: candidate.segments ?? null,
  }))));
  return hash.digest('hex');
}
