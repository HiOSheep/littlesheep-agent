import { describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@littlesheep/types';
import { MemoryTree } from './memory-tree.js';
import { InjectionTier } from './types.js';
import type {
  BranchExpansion,
  BranchIndex,
  LogFn,
  MemoryBranch,
  MemoryBranchContext,
  MemoryFragment,
} from './types.js';
import { estimateTokens } from './util.js';

function makeFragment(id: string, content = 'remember this'): MemoryFragment {
  return {
    id,
    branchId: 'daily',
    tier: InjectionTier.T2_RELEVANT,
    priority: 0.8,
    content,
    tokenEstimate: estimateTokens(content),
    truncatable: true,
    dedupKey: `daily:${id}`,
    matchReason: 'test match',
    metadata: { source: `test:${id}`, kind: 'test', generatedAt: '2026-07-10T00:00:00.000Z' },
  };
}

function makeBranch(options: {
  id?: 'daily' | 'long-term';
  fragments?: MemoryFragment[];
  failIndex?: boolean;
  failSearch?: boolean;
  invalidate?: () => void | Promise<void>;
} = {}): MemoryBranch {
  const id = options.id ?? 'daily';
  return {
    id,
    kind: id,
    displayName: id === 'daily' ? 'Daily' : 'Long-term',
    purpose: 'test memory branch',
    whenToUse: 'testing recall',
    searchHints: ['test'],
    async getIndex(ctx): Promise<BranchIndex> {
      if (options.failIndex) throw new Error('index exploded');
      return {
        branchId: id,
        displayName: id,
        summary: 'test index',
        entries: [{ id: `${id}:node`, title: 'Node', summary: 'Indexed node', hasChildren: false }],
        generatedAt: ctx.now.toISOString(),
        source: 'test',
      };
    },
    async expand(_ctx, request): Promise<BranchExpansion> {
      return { branchId: id, query: request.query, fragments: options.fragments ?? [], truncated: false };
    },
    async search(): Promise<MemoryFragment[]> {
      if (options.failSearch) throw new Error('search exploded');
      return options.fragments ?? [];
    },
    invalidate: options.invalidate,
  };
}

function begin(tree: MemoryTree, runId = 'run-1'): void {
  tree.beginRun({
    runId,
    sessionId: 'session-1' as SessionId,
    query: 'what happened',
    recentHistory: [],
    workspace: 'D:/workspace',
    now: new Date('2026-07-10T00:00:00.000Z'),
  });
}

describe('MemoryTree index-first protocol', () => {
  it('keeps the root index bounded and independent of branch contents', async () => {
    const fragments = [makeFragment('a')];
    const tree = new MemoryTree({ rootIndexMaxChars: 700 });
    tree.register(makeBranch({ fragments }));
    const before = tree.rootIndex();
    fragments.push(makeFragment('b'), makeFragment('c'));
    const after = tree.rootIndex();

    expect(after).toBe(before);
    expect(after.length).toBeLessThanOrEqual(700);
    expect(after).toContain('branch_index');
    expect(after).toContain('daily');
  });

  it('does not touch branch data until an index/expand/search action is requested', async () => {
    const getIndex = vi.fn(async (ctx: MemoryBranchContext): Promise<BranchIndex> => ({
      branchId: 'daily', displayName: 'Daily', summary: 'index', entries: [], generatedAt: ctx.now.toISOString(), source: 'test',
    }));
    const branch = makeBranch();
    branch.getIndex = getIndex;
    const tree = new MemoryTree();
    tree.register(branch);
    begin(tree);

    expect(getIndex).not.toHaveBeenCalled();
    await tree.branchIndex('run-1', 'daily');
    expect(getIndex).toHaveBeenCalledTimes(1);
  });

  it('primes a bounded initial atom only after D1 index inspection', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    tree.register(makeBranch({ fragments: [makeFragment('initial', 'relevant initial context')] }));
    begin(tree);

    const primed = await tree.prime('run-1', { query: 'Indexed node context', maxAtoms: 1, tokenBudget: 100 });
    expect(primed.fragments.map((fragment) => fragment.id)).toEqual(['initial']);
    expect(primed.indexedBranches).toEqual(['daily']);
    expect(tree.getLedger('run-1')!.records.map((record) => record.action)).toEqual([
      'root_index', 'branch_index', 'expand',
    ]);
    expect(tree.getLedger('run-1')!.records[1]).toMatchObject({
      action: 'branch_index', tokensUsed: 0, tokenBudget: 0,
    });
  });

  it('bounds TaskBook refinements and skips normalized duplicate queries', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    tree.register(makeBranch({ fragments: [makeFragment('refined', 'taskbook-specific context')] }));
    begin(tree);

    const first = await tree.refine('run-1', {
      query: 'Indexed node context',
      maxAtoms: 1,
      tokenBudget: 100,
      purpose: 'taskbook',
    });
    const duplicate = await tree.refine('run-1', {
      query: '  indexed   node CONTEXT  ',
      maxAtoms: 1,
      tokenBudget: 100,
      purpose: 'taskbook',
    });
    await tree.refine('run-1', { query: 'Indexed node context 2', purpose: 'replan' });
    await tree.refine('run-1', { query: 'Indexed node context 3', purpose: 'replan' });
    await tree.refine('run-1', { query: 'Indexed node context 4', purpose: 'replan' });
    const limited = await tree.refine('run-1', { query: 'Indexed node context 5', purpose: 'replan' });

    expect(first.fragments.map((fragment) => fragment.id)).toEqual(['refined']);
    expect(duplicate).toMatchObject({ fragments: [], skippedReason: 'duplicate-query' });
    expect(limited).toMatchObject({ fragments: [], skippedReason: 'refinement-limit' });
    expect(tree.getLedger('run-1')?.records.some((record) => record.reason?.includes('taskbook atom selection'))).toBe(true);
  });

  it('resolves a referential request through bounded recent history before D1 admission', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const branch = makeBranch({ fragments: [makeFragment('history-target', 'Atom routing uses task relevance.')] });
    const getIndex = vi.fn(async (ctx: MemoryBranchContext): Promise<BranchIndex> => ({
      branchId: 'daily',
      displayName: 'Daily',
      summary: 'history-aware index',
      entries: [{
        id: 'daily:history-target',
        title: 'Atom 注入相关性',
        summary: '按任务相关性选择 Atom。',
        hasChildren: false,
      }],
      generatedAt: ctx.now.toISOString(),
      source: 'test',
    }));
    branch.getIndex = getIndex;
    tree.register(branch);
    tree.beginRun({
      runId: 'run-history',
      sessionId: 'session-history' as SessionId,
      query: '继续处理它',
      recentHistory: [
        { role: 'user', content: '请优化 Atom 注入相关性。' },
        { role: 'assistant', content: '下一步处理多轮指代。' },
      ],
      workspace: 'D:/workspace',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });

    const primed = await tree.prime('run-history', { query: '继续处理它', maxAtoms: 1, tokenBudget: 100 });

    expect(primed.fragments.map((fragment) => fragment.id)).toEqual(['history-target']);
    expect(getIndex).toHaveBeenCalledWith(expect.objectContaining({
      query: '继续处理它',
      taskQuery: expect.objectContaining({ historyUsed: true, historyMessageCount: 2 }),
    }));
  });

  it('falls back to a session summary across a compaction boundary without making it default context', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const branch = makeBranch({ fragments: [makeFragment('summary-target', 'Aster checkpoints survive restart.')] });
    branch.getIndex = async (ctx): Promise<BranchIndex> => ({
      branchId: 'daily',
      displayName: 'Daily',
      summary: 'summary-aware index',
      entries: [{
        id: 'daily:summary-target',
        title: 'Aster checkpoint recovery',
        summary: 'Resume interrupted long tasks from a bounded checkpoint.',
        hasChildren: false,
      }],
      generatedAt: ctx.now.toISOString(),
      source: 'test',
    });
    tree.register(branch);
    tree.beginRun({
      runId: 'run-summary',
      sessionId: 'session-summary' as SessionId,
      query: '继续',
      recentHistory: [{ role: 'assistant', content: '下一步继续执行。' }],
      continuitySummary: {
        id: 'summary-aster',
        content: '当前目标：完成 Aster checkpoint recovery。下一步验证跨重启恢复。',
      },
      workspace: 'D:/workspace',
      now: new Date('2026-07-10T00:00:00.000Z'),
    });

    const primed = await tree.prime('run-summary', { query: '继续', maxAtoms: 1, tokenBudget: 100 });

    expect(primed.fragments.map((fragment) => fragment.id)).toEqual(['summary-target']);
    expect(tree.getTaskQuery('run-summary')).toMatchObject({
      summaryUsed: true,
      continuitySummaryId: 'summary-aster',
    });
    expect(tree.getLedger('run-summary')!.records.find((record) => record.action === 'branch_index')?.reason)
      .toContain('summary=summary-aster');
  });

  it('does not inject unrelated atoms merely to fill the initial working set', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const branch = makeBranch({ fragments: [makeFragment('unrelated', 'pnpm workspace preference')] });
    branch.getIndex = async (ctx): Promise<BranchIndex> => ({
      branchId: 'daily',
      displayName: 'Daily',
      summary: 'one unrelated atom',
      entries: [{
        id: 'daily:unrelated',
        title: 'Package manager preference',
        summary: 'Use pnpm for repository scripts.',
        hasChildren: false,
        relevance: 0.14,
      }],
      generatedAt: ctx.now.toISOString(),
      source: 'test',
    });
    tree.register(branch);
    begin(tree);

    const primed = await tree.prime('run-1', {
      query: 'What is the weather tomorrow?',
      maxAtoms: 2,
      tokenBudget: 100,
    });

    expect(primed.fragments).toEqual([]);
    expect(primed.indexedBranches).toEqual(['daily']);
    expect(tree.getLedger('run-1')!.records).toHaveLength(2);
    expect(tree.getLedger('run-1')!.records[1]).toMatchObject({
      action: 'branch_index',
      status: 'ok',
      fragmentIds: [],
      tokensUsed: 0,
    });
    expect(tree.getLedger('run-1')!.records[1]!.reason).toContain('0 candidate(s)');
  });

  it('does not admit a substantially weaker candidate merely because it shares generic task terms', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const branch = makeBranch({ fragments: [makeFragment('selected', 'Atom injection uses task relevance.')] });
    const expand = vi.fn(branch.expand.bind(branch));
    branch.expand = expand;
    branch.getIndex = async (ctx): Promise<BranchIndex> => ({
      branchId: 'daily',
      displayName: 'Daily',
      summary: 'task-specific and generic candidates',
      entries: [
        {
          id: 'daily:target',
          title: 'Atom injection relevance',
          summary: 'Route memory context by the current task.',
          searchKeys: ['Atom injection relevance'],
          hasChildren: false,
          relevance: 0.75,
          metadata: { taskRelevanceResolved: true, priority: { score: 0.8 } },
        },
        {
          id: 'daily:generic',
          title: 'Atom maintenance plan',
          summary: 'Maintain Atom records after writes.',
          searchKeys: ['Atom'],
          hasChildren: false,
          relevance: 0.54,
          metadata: { taskRelevanceResolved: true, priority: { score: 0.9 } },
        },
      ],
      generatedAt: ctx.now.toISOString(),
      source: 'test',
    });
    tree.register(branch);
    begin(tree);

    await tree.prime('run-1', {
      query: 'check Atom injection relevance',
      maxAtoms: 2,
      tokenBudget: 100,
    });

    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nodeId: 'daily:target' }));
  });

  it('evaluates the full bounded D1 index instead of only its first eight entries', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const branch = makeBranch({ fragments: [makeFragment('selected', 'target atom content')] });
    const expand = vi.fn(branch.expand.bind(branch));
    branch.expand = expand;
    branch.getIndex = async (ctx): Promise<BranchIndex> => ({
      branchId: 'daily',
      displayName: 'Daily',
      summary: 'bounded candidates',
      entries: [
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `daily:distractor-${index}`,
          title: `Distractor ${index}`,
          summary: 'Unrelated package metadata.',
          hasChildren: false,
          relevance: 0,
        })),
        {
          id: 'daily:target',
          title: 'Aurora retention policy',
          summary: 'The exact task-specific memory.',
          hasChildren: false,
          relevance: 0.95,
        },
      ],
      generatedAt: ctx.now.toISOString(),
      source: 'test',
    });
    tree.register(branch);
    begin(tree);

    const primed = await tree.prime('run-1', {
      query: 'aurora retention policy',
      maxAtoms: 1,
      tokenBudget: 100,
    });

    expect(primed.fragments.map((fragment) => fragment.id)).toEqual(['selected']);
    expect(expand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nodeId: 'daily:target' }));
  });

  it('uses governed candidate priority after the task-relevance admission gate', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const branch = makeBranch({ fragments: [makeFragment('selected')] });
    const expand = vi.fn(branch.expand.bind(branch));
    branch.expand = expand;
    branch.getIndex = async (ctx): Promise<BranchIndex> => ({
      branchId: 'daily',
      displayName: 'Daily',
      summary: 'conflicting candidates',
      entries: [
        {
          id: 'daily:disputed',
          title: 'Exact disputed wording',
          summary: 'A disputed statement with stronger lexical overlap.',
          hasChildren: false,
          relevance: 1,
          metadata: { priority: { score: 0.42 } },
        },
        {
          id: 'daily:verified',
          title: 'Verified rule',
          summary: 'The current verified rule.',
          hasChildren: false,
          relevance: 0.8,
          metadata: { priority: { score: 0.81 } },
        },
      ],
      generatedAt: ctx.now.toISOString(),
      source: 'test',
    });
    tree.register(branch);
    begin(tree);

    await tree.prime('run-1', { query: 'current verified rule', maxAtoms: 1, tokenBudget: 100 });

    expect(expand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      nodeId: 'daily:verified',
      query: 'current verified rule',
    }));
  });

  it('does not treat branch descriptions as relevance for every atom in the branch', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const branch = makeBranch({ fragments: [makeFragment('unrelated')] });
    branch.getIndex = async (ctx): Promise<BranchIndex> => ({
      branchId: 'daily',
      displayName: 'Daily',
      summary: 'one atom',
      entries: [{
        id: 'daily:unrelated',
        title: 'Package manager preference',
        summary: 'Use pnpm for repository scripts.',
        hasChildren: false,
      }],
      generatedAt: ctx.now.toISOString(),
      source: 'test',
    });
    tree.register(branch);
    begin(tree);

    const primed = await tree.prime('run-1', {
      query: 'testing recall',
      maxAtoms: 1,
      tokenBudget: 100,
    });

    expect(primed.fragments).toEqual([]);
  });

  it('rejects expansion before the branch index without touching branch content or spending tokens', async () => {
    const branch = makeBranch({ fragments: [makeFragment('hidden')] });
    const expand = vi.fn(branch.expand.bind(branch));
    branch.expand = expand;
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    tree.register(branch);
    begin(tree);
    const tokensBefore = tree.getLedger('run-1')!.tokensUsed;

    await expect(tree.expand('run-1', { branchId: 'daily', query: 'hidden' }))
      .rejects.toThrow('branch_index');

    expect(expand).not.toHaveBeenCalled();
    const ledger = tree.getLedger('run-1')!;
    expect(ledger.tokensUsed).toBe(tokensBefore);
    expect(ledger.records.at(-1)).toMatchObject({
      action: 'expand',
      branchId: 'daily',
      status: 'error',
      sourceCount: 0,
      tokensUsed: 0,
    });
  });

  it('budgets and deduplicates repeated intervention within one run', async () => {
    const content = 'x'.repeat(240);
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 200 });
    tree.register(makeBranch({ fragments: [makeFragment('large', content)] }));
    begin(tree);
    await tree.branchIndex('run-1', 'daily');

    const first = await tree.expand('run-1', { branchId: 'daily', query: 'x', tokenBudget: 80 });
    expect(first.fragments).toHaveLength(1);
    expect(first.fragments[0]!.tokenEstimate).toBeLessThanOrEqual(80);
    expect(first.truncated).toBe(false);

    const second = await tree.expand('run-1', { branchId: 'daily', query: 'x', tokenBudget: 80 });
    expect(second.fragments).toHaveLength(0);
    expect(second.dedupedCount).toBe(1);

    const ledger = tree.getLedger('run-1')!;
    expect(ledger.records.map((record) => record.action)).toEqual(['root_index', 'branch_index', 'expand', 'expand']);
    expect(ledger.dedupKeys).toContain('daily:large');
    expect(ledger.tokensUsed).toBeGreaterThan(0);
  });

  it('releases an active atom, refunds its budget, and allows an explicit re-add', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 200 });
    tree.register(makeBranch({ fragments: [makeFragment('releasable', 'remember the exact build constraint')] }));
    begin(tree);
    await tree.branchIndex('run-1', 'daily');
    const first = await tree.expand('run-1', { branchId: 'daily', nodeId: 'daily:node', tokenBudget: 100 });
    const tokensWithAtom = tree.getLedger('run-1')!.tokensUsed;

    const released = await tree.release('run-1', ['releasable']);
    expect(released.releasedAtomIds).toEqual(['releasable']);
    expect(released.freedTokens).toBe(first.fragments[0]!.tokenEstimate);
    expect(tree.getLedger('run-1')!.tokensUsed).toBe(tokensWithAtom - released.freedTokens);
    expect(tree.getLedger('run-1')!.dedupKeys).not.toContain('daily:releasable');

    const readded = await tree.expand('run-1', { branchId: 'daily', nodeId: 'daily:node', tokenBudget: 100 });
    expect(readded.fragments.map((fragment) => fragment.id)).toEqual(['releasable']);
    expect(tree.getLedger('run-1')!.records.map((record) => record.action)).toEqual([
      'root_index', 'branch_index', 'expand', 'release', 'expand',
    ]);
  });

  it('returns an overflow index instead of injecting a partial oversized fragment', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 200 });
    tree.register(makeBranch({ fragments: [makeFragment('oversized', 'x'.repeat(1_200))] }));
    begin(tree);
    await tree.branchIndex('run-1', 'daily');
    const result = await tree.expand('run-1', { branchId: 'daily', query: 'x', tokenBudget: 80 });
    expect(result.fragments).toEqual([]);
    expect(result.childIndex).toMatchObject([{ id: 'oversized', metadata: { omittedForBudget: true } }]);
    expect(result.truncated).toBe(true);
    expect(tree.getLedger('run-1')!.dedupKeys).not.toContain('daily:oversized');
  });

  it('rejects deep search until one branch has been indexed and expanded', async () => {
    const branch = makeBranch({ fragments: [makeFragment('hidden')] });
    const search = vi.fn(branch.search.bind(branch));
    branch.search = search;
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    tree.register(branch);
    begin(tree);
    const tokensBefore = tree.getLedger('run-1')!.tokensUsed;

    await expect(tree.deepSearch('run-1', { query: 'remember' } as never))
      .rejects.toThrow('explicit branch');
    await tree.branchIndex('run-1', 'daily');
    await expect(tree.deepSearch('run-1', { branchId: 'daily', query: 'remember' }))
      .rejects.toThrow('has not been expanded');

    expect(search).not.toHaveBeenCalled();
    const ledger = tree.getLedger('run-1')!;
    expect(ledger.records.filter((record) => record.action === 'deep_search')).toHaveLength(2);
    expect(ledger.records.at(-1)).toMatchObject({ status: 'error', sourceCount: 0, tokensUsed: 0 });
    expect(ledger.tokensUsed).toBeGreaterThan(tokensBefore);
  });

  it('deep-searches only the selected branch after indexed expansion', async () => {
    const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 300 });
    const daily = makeBranch({ id: 'daily' });
    const longTerm = makeBranch({
      id: 'long-term',
      fragments: [{ ...makeFragment('good'), branchId: 'long-term', dedupKey: 'long-term:good' }],
    });
    const dailySearch = vi.fn(daily.search.bind(daily));
    const longTermSearch = vi.fn(longTerm.search.bind(longTerm));
    longTerm.expand = vi.fn(async (_ctx, request) => ({
      branchId: 'long-term',
      nodeId: request.nodeId,
      query: request.query,
      fragments: [],
      truncated: false,
    }));
    daily.search = dailySearch;
    longTerm.search = longTermSearch;
    tree.register(daily);
    tree.register(longTerm);
    begin(tree);
    await tree.branchIndex('run-1', 'long-term');
    await tree.expand('run-1', { branchId: 'long-term', nodeId: 'long-term:node' });

    const result = await tree.deepSearch('run-1', { branchId: 'long-term', query: 'remember' });
    expect(result.fragments.map((entry) => entry.id)).toContain('good');
    expect(result.errors).toEqual([]);
    expect(longTermSearch).toHaveBeenCalledTimes(1);
    expect(dailySearch).not.toHaveBeenCalled();
  });

  it('returns a degraded branch index instead of aborting the run', async () => {
    const tree = new MemoryTree();
    tree.register(makeBranch({ failIndex: true }));
    begin(tree);
    const index = await tree.branchIndex('run-1', 'daily');
    expect(index.entries).toEqual([]);
    expect(index.summary).toContain('temporarily unavailable');
  });

  it('finalizes and retains an immutable diagnostic ledger', () => {
    const tree = new MemoryTree();
    tree.register(makeBranch());
    begin(tree);
    const completed = tree.finishRun('run-1')!;
    expect(completed.endedAt).toBeTruthy();
    completed.records.length = 0;
    expect(tree.getLedger('run-1')!.records).toHaveLength(1);
  });

  it('lists cloned active and completed ledgers for management diagnostics', () => {
    const tree = new MemoryTree();
    tree.register(makeBranch());
    begin(tree, 'run-1');
    tree.finishRun('run-1');
    begin(tree, 'run-2');

    const ledgers = tree.listLedgers();
    expect(new Set(ledgers.map((ledger) => ledger.runId))).toEqual(new Set(['run-1', 'run-2']));
    expect(tree.listLedgers(1)).toHaveLength(1);
    ledgers[0]!.records.length = 0;
    expect(tree.listLedgers().every((ledger) => ledger.records.length > 0)).toBe(true);
  });
});

describe('MemoryTree branch lifecycle', () => {
  it('invalidates the registered branch and isolates invalidation errors', async () => {
    const messages: string[] = [];
    const log: LogFn = (_level, message) => messages.push(message);
    const invalidate = vi.fn(() => { throw new Error('cache failed'); });
    const tree = new MemoryTree({ log });
    tree.register(makeBranch({ invalidate }));

    await expect(tree.invalidateBranch('daily')).resolves.toBeUndefined();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(messages.some((message) => message.includes('cache failed'))).toBe(true);
  });

  it('replaces duplicate branch ids and keeps a stable sorted registry', () => {
    const tree = new MemoryTree();
    tree.register(makeBranch({ id: 'long-term' }));
    tree.register(makeBranch({ id: 'daily' }));
    tree.register(makeBranch({ id: 'daily' }));
    expect(tree.list().map((branch) => branch.id)).toEqual(['daily', 'long-term']);
  });
});
