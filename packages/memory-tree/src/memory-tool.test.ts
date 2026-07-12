import { describe, expect, it, vi } from 'vitest';
import type { SessionId, ToolContext } from '@littlesheep/types';
import { MemoryTree } from './memory-tree.js';
import { createMemorySearchCompatibilityTool, createMemoryTreeTool } from './memory-tool.js';
import { InjectionTier } from './types.js';
import type { MemoryBranch } from './types.js';

function branch(): MemoryBranch {
  return {
    id: 'long-term', kind: 'long-term', displayName: 'Long-term', purpose: 'durable facts',
    whenToUse: 'a preference matters', searchHints: ['preference'],
    async getIndex(ctx) {
      return {
        branchId: 'long-term', displayName: 'Long-term', summary: 'one node',
        entries: [{ id: 'node-1', title: 'Preference', summary: 'concise replies', hasChildren: false }],
        generatedAt: ctx.now.toISOString(), source: 'test',
      };
    },
    async expand() {
      return {
        branchId: 'long-term', fragments: [{
          id: 'node-1', branchId: 'long-term', tier: InjectionTier.T2_RELEVANT, priority: 1,
          content: 'User prefers concise replies.', tokenEstimate: 8, truncatable: true,
          dedupKey: 'node-1', matchReason: 'selected node',
          metadata: { source: 'test', kind: 'indexed', generatedAt: '2026-07-10T00:00:00.000Z' },
        }], truncated: false,
      };
    },
    async search() { return (await this.expand({} as never, {} as never)).fragments; },
  };
}

function setup() {
  const tree = new MemoryTree({ totalRunTokenBudget: 1_000, perBranchTokenBudget: 500 });
  const memoryBranch = branch();
  tree.register(memoryBranch);
  tree.beginRun({
    runId: 'run-1', sessionId: 'session-1' as SessionId, query: 'remember preference',
    recentHistory: [], workspace: 'D:/workspace',
  });
  const ctx: ToolContext = { runId: 'run-1', sessionId: 'session-1' as SessionId, cwd: 'D:/workspace' };
  return { tree, ctx, memoryBranch };
}

describe('memory_tree agent tools', () => {
  it('navigates branch index then expansion and applies the read-side envelope', async () => {
    const { tree, ctx } = setup();
    const tool = createMemoryTreeTool(tree, { envelope: (content) => `<safe>${content}</safe>` });
    const index = await tool.execute({ action: 'branch_index', branch: 'long-term' }, ctx);
    const expansion = await tool.execute({ action: 'expand', branch: 'long-term', nodeId: 'node-1' }, ctx);

    expect(index.ok).toBe(true);
    expect(index.output).toContain('<safe>');
    expect(index.output).toContain('[node-1]');
    expect(expansion.output).toContain('User prefers concise replies.');
    expect(tree.getLedger('run-1')!.records.map((record) => record.action)).toEqual([
      'root_index', 'branch_index', 'expand',
    ]);
  });

  it('keeps legacy memory_search index-only and requires memory_tree to expand content', async () => {
    const { tree, ctx } = setup();
    const compatibility = createMemorySearchCompatibilityTool(tree);
    const root = await compatibility.execute({ query: 'preference' }, ctx);
    const index = await compatibility.execute({ query: 'preference', branch: 'long-term' }, ctx);

    expect(root.output).toContain('Memory Tree Root Index');
    expect(root.output).not.toContain('User prefers concise replies.');
    expect(root.meta).toMatchObject({ searched: false, nextAction: 'branch_index' });
    expect(index.output).toContain('[node-1]');
    expect(index.output).not.toContain('User prefers concise replies.');
    expect(index.meta).toMatchObject({ searched: false, nextAction: 'expand' });

    const memoryTree = createMemoryTreeTool(tree);
    const expansion = await memoryTree.execute(
      { action: 'expand', branch: 'long-term', nodeId: 'node-1' },
      ctx,
    );
    expect(expansion.output).toContain('User prefers concise replies.');
    expect(tree.getLedger('run-1')!.records.map((record) => record.action)).toEqual([
      'root_index', 'branch_index', 'expand',
    ]);
  });

  it('returns a navigational error instead of searching when deep_search skips expand', async () => {
    const { tree, ctx, memoryBranch } = setup();
    const search = vi.spyOn(memoryBranch, 'search');
    const tool = createMemoryTreeTool(tree);
    await tool.execute({ action: 'branch_index', branch: 'long-term' }, ctx);
    const result = await tool.execute(
      { action: 'deep_search', branch: 'long-term', query: 'preference' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('has not been expanded');
    expect(search).not.toHaveBeenCalled();
    expect(tree.getLedger('run-1')!.records.at(-1)).toMatchObject({
      action: 'deep_search', status: 'error', tokensUsed: 0,
    });
  });
});
