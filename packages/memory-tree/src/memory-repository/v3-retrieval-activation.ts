// Builds a bounded hot-plus-recent D1 fallback without scanning every atom file.

import type { MemoryCatalog } from '../v3/catalog.js';
import { memoryCatalogActivationScore } from '../v3/activation.js';
import type { MemoryRepositoryIndexRequest } from './retrieval.js';

export function listActivationFallback(
  catalog: MemoryCatalog,
  request: MemoryRepositoryIndexRequest,
  scope: { scope: MemoryRepositoryIndexRequest['scopes'][number]['scope']; storageScopeKey?: string },
  limit: number,
) {
  const poolLimit = Math.min(400, Math.max(limit * 2, 80));
  const common = {
    branch: request.branch,
    scope: scope.scope,
    scopeKey: scope.storageScopeKey,
    status: 'active' as const,
    limit: poolLimit,
  };
  const merged = new Map<string, ReturnType<MemoryCatalog['listAtoms']>[number]>();
  for (const entry of catalog.listAtoms({ ...common, orderBy: 'activation' })) {
    merged.set(entry.atomId, entry);
  }
  for (const entry of catalog.listAtoms({ ...common, orderBy: 'updated' })) {
    merged.set(entry.atomId, entry);
  }
  return [...merged.values()]
    .sort((left, right) => memoryCatalogActivationScore(right, request.now)
      - memoryCatalogActivationScore(left, request.now)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.atomId.localeCompare(right.atomId))
    .slice(0, limit);
}
