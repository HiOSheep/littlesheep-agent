import { describe, expect, it, vi } from 'vitest';
import type { MemoryRunRefinementServiceLike } from '@littlesheep/memory-tree';
import type { TaskBook } from '@littlesheep/types';
import { makeCtx } from './tests/helpers.js';
import {
  buildTaskBookMemoryQuery,
  buildTaskBookMemoryTaskQuery,
  refineMemoryForTaskBook,
} from './memory-taskbook-refinement.js';

describe('TaskBook memory refinement', () => {
  it('builds a bounded query from the goal, acceptance criteria and unfinished steps', () => {
    const query = buildTaskBookMemoryQuery(taskBook());

    expect(query).toContain('Goal: Repair Memory v3 task-aware injection');
    expect(query).toContain('Success: The execute stage receives the relevant atom');
    expect(query).toContain('Step: Refine working set - Select atoms from the normalized TaskBook');
    expect(query).not.toContain('Already complete');
    expect(query.length).toBeLessThanOrEqual(1_600);
    const taskQuery = buildTaskBookMemoryTaskQuery(taskBook());
    expect(taskQuery.positiveSegments.map((segment) => segment.text)).toEqual(expect.arrayContaining([
      'Repair Memory v3 task-aware injection',
      'The execute stage receives the relevant atom',
    ]));
  });

  it('adds refined atoms to the system-resident working set and synchronizes KnownState', async () => {
    const ctx = makeCtx();
    const refineRun = vi.fn(async () => ({
      ledger: {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        workspace: ctx.toolContext.cwd,
        startedAt: '2026-07-17T08:00:00.000Z',
        totalTokenBudget: 3_200,
        tokensUsed: 180,
        expandedBranches: ['project'],
        dedupKeys: ['project:atom-refined'],
        records: [],
        knownState: {
          version: 1 as const,
          runId: ctx.runId,
          revision: 1,
          updatedAt: '2026-07-17T08:00:01.000Z',
          references: [],
        },
      },
      context: {
        content: '# TaskBook Refined Memory Atoms\nrefined memory body',
        atomIds: ['atom-refined'],
        fragments: [],
      },
    }));
    const service: MemoryRunRefinementServiceLike = { refineRun };

    const result = await refineMemoryForTaskBook(ctx, taskBook(), service, 'taskbook');

    expect(result.addedAtomIds).toEqual(['atom-refined']);
    expect(ctx.initialMemoryContext).toContain('refined memory body');
    expect(ctx.memoryContextWorkingSet).toMatchObject({
      activeAtomIds: ['atom-refined'],
      releasedAtomIds: [],
      callAtomIds: { initial: ['atom-refined'] },
    });
    expect(ctx.memoryKnownState?.runId).toBe(ctx.runId);
    expect(refineRun).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'taskbook',
      maxAtoms: 2,
      tokenBudget: 400,
    }));
  });
});

function taskBook(): TaskBook {
  return {
    assessment: {
      userNeed: 'Improve task-aware memory injection.',
      complexity: 'standard',
      goal: 'Repair Memory v3 task-aware injection',
      successCriteria: ['The execute stage receives the relevant atom'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1.5,
    },
    goal: 'Repair Memory v3 task-aware injection',
    complexity: 'standard',
    successCriteria: ['The execute stage receives the relevant atom'],
    steps: [
      {
        id: 'step-1',
        title: 'Refine working set',
        description: 'Select atoms from the normalized TaskBook',
        acceptanceCriteria: ['Only relevant atoms are added'],
        status: 'pending',
      },
      { id: 'step-2', description: 'Already complete', status: 'done' },
    ],
    overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'Stay within scope.' },
  };
}
