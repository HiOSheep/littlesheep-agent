// Shared contracts for bounded, atomic cache projections.

export const MAX_CACHE_COMPRESSION_DEPTH = 3 as const;

export type CacheCompressionDepth = 1 | 2 | 3;
export type CacheDisclosureLevel = 'D1' | 'D2' | 'D3';
export type CacheDataClass = 'semantic' | 'operational' | 'binary' | 'ui-projection';

/**
 * Vector namespaces are explicit so operational caches can never drift into
 * the durable memory recall pool by accident.
 */
export type CacheVectorClass = 'memory-atom' | 'semantic-cache' | 'excluded';

export interface AtomicCacheMetadata {
  version: 1;
  namespace: string;
  dataClass: CacheDataClass;
  compressionDepth: CacheCompressionDepth;
  disclosureLevel: CacheDisclosureLevel;
  vectorClass: CacheVectorClass;
  sourceRefs: string[];
  contentHash: string;
  createdAt: string;
  expiresAt?: string;
}

export function nextCacheCompressionDepth(previous?: number): CacheCompressionDepth {
  if (!Number.isFinite(previous) || previous === undefined || previous < 1) return 1;
  return Math.min(MAX_CACHE_COMPRESSION_DEPTH, Math.floor(previous) + 1) as CacheCompressionDepth;
}
