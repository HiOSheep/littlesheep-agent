// Runner adapter for durable, redacted cache observation persistence.
import type { CacheObservation } from '@littlesheep/types';
import {
  CacheObservationStore,
  type CacheScopeInput,
} from '@littlesheep/harness';

export type CacheObservationLog = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

export function createCacheObservationPersistence(
  store: CacheObservationStore | undefined,
  scope: CacheScopeInput,
  log?: CacheObservationLog,
): ((observation: CacheObservation) => Promise<void>) | undefined {
  if (!store) return undefined;
  return async (observation) => {
    const stored = await store.put(observation, scope);
    if (!stored.stored) {
      log?.('warn', `runner: cache observation persistence unavailable (${stored.reason})`);
    }
  };
}
