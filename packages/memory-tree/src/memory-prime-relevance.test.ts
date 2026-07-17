import { describe, expect, it } from 'vitest';
import { scoreMemoryPrimeIndexEntry } from './memory-prime-relevance.js';
import { composeMemoryTaskQuery } from './task-query.js';

describe('memory prime relevance', () => {
  it('does not overturn a full Atom relevance decision with a partial D1 projection', () => {
    const taskQuery = composeMemoryTaskQuery('不要旧方案，改用新方案');
    const score = scoreMemoryPrimeIndexEntry(taskQuery, {
      id: 'constraint',
      title: '旧方案已被否决',
      summary: 'decision/verified; task=0.900',
      searchKeys: ['旧方案'],
      relevance: 0.9,
      hasChildren: false,
      metadata: {
        taskRelevanceResolved: true,
        priority: { score: 0.82 },
      },
    });

    expect(score).toEqual({ taskRelevance: 0.9, selectionScore: 0.82 });
  });

  it('still blocks unresolved compatibility entries that match an excluded subject', () => {
    const taskQuery = composeMemoryTaskQuery('不要旧方案，改用新方案');
    const score = scoreMemoryPrimeIndexEntry(taskQuery, {
      id: 'old-plan',
      title: '旧方案',
      summary: '重放全部历史。',
      searchKeys: ['旧方案'],
      relevance: 1,
      hasChildren: false,
    });

    expect(score).toEqual({ taskRelevance: 0, selectionScore: 0 });
  });
});
