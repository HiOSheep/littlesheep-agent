import { describe, expect, it, vi } from 'vitest';
import { InjectionTier } from '../types.js';
import {
  MEMORY_VECTOR_NAMESPACE,
  type MemoryCatalogEntry,
} from '../v3/contracts.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import { listActivationFallback } from './v3-retrieval-activation.js';

describe('Memory v3 D1 activation fallback', () => {
  it('keeps an older high-value Atom inside the bounded hot-plus-recent window', () => {
    const hot = entry('old-hot', 0.92, '2025-01-01T00:00:00.000Z');
    const recent = Array.from({ length: 12 }, (_, index) => entry(
      `recent-${index}`,
      0.12 + index / 1_000,
      `2026-07-17T00:${String(index).padStart(2, '0')}:00.000Z`,
    ));
    const listAtoms = vi.fn((request: { orderBy?: string }) => request.orderBy === 'activation'
      ? [hot, ...recent.slice(0, 3)]
      : recent);
    const catalog = { listAtoms } as unknown as MemoryCatalog;

    const selected = listActivationFallback(catalog, {
      branch: 'long-term',
      scopes: [{ scope: 'global' }],
      query: '',
      limit: 4,
      now: '2026-07-17T01:00:00.000Z',
    }, { scope: 'global' }, 4);

    expect(selected).toHaveLength(4);
    expect(selected[0]?.atomId).toBe(hot.atomId);
    expect(listAtoms).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orderBy: 'activation',
      limit: 80,
    }));
    expect(listAtoms).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: 'updated',
      limit: 80,
    }));
  });
});

function entry(atomId: string, activationScore: number, updatedAt: string): MemoryCatalogEntry {
  return {
    atomId,
    filePath: `atoms/${atomId}.json`,
    revision: 1,
    domain: 'knowledge',
    branch: 'long-term',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    statementKind: 'factual-claim',
    epistemicStatus: 'verified',
    status: 'active',
    resolutionStatus: 'resolved',
    contentHash: atomId,
    embeddingHash: atomId,
    vectorNamespace: MEMORY_VECTOR_NAMESPACE,
    embeddingStatus: 'disabled',
    activationScore,
    activationUpdatedAt: '2026-07-17T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt,
  };
}
