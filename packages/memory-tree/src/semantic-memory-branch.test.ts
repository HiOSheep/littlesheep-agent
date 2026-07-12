import { describe, expect, it, vi } from 'vitest';
import type { MemoryBranchContext } from './types.js';
import { SemanticDailyBranch, type VectorMemorySearchLike } from './legacy-memory-branches.js';

function context(): MemoryBranchContext {
  return {
    runId: 'run-1',
    sessionId: 'session-1' as never,
    query: 'renamed concept',
    recentHistory: [],
    workspace: 'D:/workspace',
    signal: new AbortController().signal,
    now: new Date('2026-07-11T00:00:00.000Z'),
  };
}

describe('SemanticDailyBranch index-first behavior', () => {
  it('does not query the vector store during ordinary indexed expansion', async () => {
    const search = vi.fn(async () => []);
    const branch = new SemanticDailyBranch({ search } as VectorMemorySearchLike);

    const expansion = await branch.expand(context(), {
      query: 'renamed concept',
      limit: 10,
      tokenBudget: 200,
    });

    expect(expansion.fragments).toEqual([]);
    expect(search).not.toHaveBeenCalled();

    await branch.search(context(), {
      query: 'renamed concept',
      limit: 10,
      tokenBudget: 200,
    });
    expect(search).toHaveBeenCalledTimes(1);
  });
});
