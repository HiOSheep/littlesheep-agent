// Serializes redacted cache observation writes without changing request semantics.
import type { CacheObservation, RunContext } from '@littlesheep/types';

export interface CacheObservationPersistenceState {
  cacheObservationPersistence?: Promise<void>;
}

export function scheduleCacheObservationPersistence(
  ctx: Pick<RunContext, 'persistCacheObservation' | 'toolContext'>,
  lifecycle: CacheObservationPersistenceState,
  observation: CacheObservation | undefined,
): void {
  if (!observation || !ctx.persistCacheObservation) return;
  const previous = lifecycle.cacheObservationPersistence ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      // The hook receives only the already-redacted observation. Persistence
      // failures are cache-quality diagnostics, never request failures.
      await ctx.persistCacheObservation!(structuredClone(observation));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        ctx.toolContext.log?.('warn', `cache observation persistence failed: ${message.slice(0, 256)}`);
      } catch {
        // Diagnostics must never turn a cache-quality failure into a request failure.
      }
    });
  lifecycle.cacheObservationPersistence = next;
}

export async function awaitCacheObservationPersistence(
  lifecycle: CacheObservationPersistenceState,
): Promise<void> {
  // A late usage/failure callback may enqueue a newer snapshot while an older
  // write is draining. Follow the tail until no newer write was published.
  while (lifecycle.cacheObservationPersistence) {
    const pending = lifecycle.cacheObservationPersistence;
    await pending;
    if (pending === lifecycle.cacheObservationPersistence) return;
  }
}
