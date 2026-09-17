// Local (non-Provider) cache ledgers.
//
// Both ledgers report only events the Runtime actually observed: an identical
// context assembly being reused, or the memory store reusing an existing
// embedding. Without such an event they stay unavailable — never estimated.
import type {
  CacheLedgerObservation,
  CacheObservationStatus,
  ContextReuseEvent,
  MemoryReuseCounts,
} from '@littlesheep/types';

export function contextReuseLedger(reuse: ContextReuseEvent | undefined): CacheLedgerObservation {
  if (!reuse) {
    return {
      kind: 'ls_context',
      status: 'unavailable',
      reason: 'context_cache_event_not_observed',
      requestCount: 1,
    };
  }
  return {
    kind: 'ls_context',
    status: reuse.status,
    reason: reuse.status === 'hit' ? 'context_assembly_reused' : 'context_assembly_rebuilt',
    requestCount: 1,
  };
}

/** Reused vectors are hits; newly queued embedding work is a miss. */
export function memoryReuseLedger(reuse: MemoryReuseCounts | undefined): CacheLedgerObservation {
  const total = reuse ? reuse.reused + reuse.queued : 0;
  if (!reuse || total === 0) {
    return {
      kind: 'memory_embedding',
      status: 'unavailable',
      reason: 'memory_cache_event_not_observed',
      requestCount: 1,
    };
  }
  const status: CacheObservationStatus = reuse.queued === 0 ? 'hit' : reuse.reused === 0 ? 'miss' : 'partial';
  return {
    kind: 'memory_embedding',
    status,
    reason: status === 'hit' ? 'embedding_reused' : status === 'miss' ? 'embedding_rebuilt' : 'embedding_partially_reused',
    requestCount: 1,
    tokenCount: total,
    cachedTokenCount: reuse.reused,
    uncachedTokenCount: reuse.queued,
    hitRatio: reuse.reused / total,
  };
}
