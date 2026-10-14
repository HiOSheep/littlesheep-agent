import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { asSessionId } from '@littlesheep/types';
import { MemoryRepository } from './memory-repository.js';
import { TreeMemoryBranch, DEFAULT_BRANCH_SPECS } from './tree-memory-branch.js';
import { InjectionTier } from './types.js';
import { InMemoryOwnershipBindings } from './memory-ownership-bindings.js';
import { bindMemoryAccessGrant, issueMemoryAccessGrant, memoryAccessRootId } from './memory-access-context.js';
import { createAtomReadAuthorization, memoryNodeAccessRevision } from './atom-read-authorization.js';

it('v2 exact/children/subtree/filtering and late revision checks never fall back to unbound nodes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ls-v2-atom-read-'));
  const repository = new MemoryRepository({ dataDir: root });
  try {
    await repository.initialize();
    const seed = async (id: string, parentNodeId = 'long-term:root') => repository.write({ id, branch: 'long-term', parentNodeId,
      scope: 'global', tier: InjectionTier.T2_RELEVANT, summary: `catalog ${id}`, content: `catalog database ${id}`,
      retrievalKeys: ['catalog'], sourceRunId: 'fixture', sourceStage: 'tool', importance: 1, confidence: 1, reason: 'Isolated fixture' });
    const parent = (await seed('allowed')).node!;
    const child = (await seed('child', parent.id)).node!;
    const denied = (await seed('PRIVATE_CHILD', parent.id)).node!;
    const store = new InMemoryOwnershipBindings();
    const rootId = memoryAccessRootId(root);
    for (const id of [parent.id, child.id]) {
      const node = (await repository.getNode(id))!;
      store.compareAndSet({ version: 1, revision: 0, entityRevision: memoryNodeAccessRevision(node), target: {
        kind: 'atom', id, binding: 'reviewed', scope: 'global', principalId: `local:${rootId}`, dataRootId: rootId } }, undefined);
    }
    const context = await bindMemoryAccessGrant(issueMemoryAccessGrant({ rootId, runId: 'r', sessionId: 's', workspace: root, current: async () => true,
      resolve: async () => ({ source: 'host', enforcement: 'enforced', policy: { version: 1, revision: 0, principalId: `local:${rootId}`, dataRootId: rootId,
        runId: 'r', sessionId: 's', readMode: 'global', writeMode: 'disabled', selected: [], disabled: [], globalWriteGranted: false } }) }),
      { runId: 'r', sessionId: 's', workspace: root }, rootId);
    const gate = createAtomReadAuthorization(context, store);
    const branch = new TreeMemoryBranch({ repository, ...DEFAULT_BRANCH_SPECS[0]!, authorization: async () => gate });
    const ctx = { runId: 'r', sessionId: asSessionId('s'), workspace: root, query: 'catalog', recentHistory: [], now: new Date(), signal: new AbortController().signal };
    const index = await branch.getIndex(ctx);
    expect(index.entries.map((entry) => entry.id).sort()).toEqual([parent.id, child.id].sort());
    expect(JSON.stringify(index)).not.toContain(denied.id);
    const expanded = await branch.expand(ctx, { nodeId: parent.id, query: 'catalog', limit: 5, tokenBudget: 1000 });
    expect(expanded.childIndex?.map((entry) => entry.id)).toEqual([child.id]);
    expect(JSON.stringify(expanded)).not.toContain(denied.id);
    expect((await branch.expand(ctx, { nodeId: denied.id, limit: 5, tokenBudget: 1000 })).fragments).toEqual([]);
    expect((await branch.search(ctx, { query: 'catalog', limit: 5, tokenBudget: 1000, subtreeRootId: denied.id }))).toEqual([]);
    expect((await branch.search(ctx, { query: 'catalog', limit: 5, tokenBudget: 1000, subtreeRootId: child.id })).map((item) => item.id)).toEqual([child.id]);
    const rootExpansion = await branch.expand(ctx, { nodeId: MemoryRepository.branchRootId('long-term'), limit: 5, tokenBudget: 1000 });
    expect(rootExpansion.childIndex?.map((entry) => entry.id)).toEqual([parent.id]);
    expect(JSON.stringify(rootExpansion.childIndex)).not.toContain(denied.id);
    await repository.setStatus(child.id, 'archived');
    const parentBinding = store.get({ kind: 'atom', id: parent.id })!;
    const revisedParent = (await repository.getNode(parent.id))!;
    store.compareAndSet({ ...parentBinding, revision: 1, entityRevision: memoryNodeAccessRevision(revisedParent) }, 0);
    expect((await branch.getIndex(ctx)).entries.find((entry) => entry.id === parent.id)?.hasChildren).toBe(false);
    const original = repository.getNode.bind(repository);
    const read = vi.spyOn(repository, 'getNode');
    read.mockImplementation(async (id) => {
      const node = await original(id);
      return node && id === parent.id ? { ...node, content: 'PRIVATE_CHANGED_BODY' } : node;
    });
    expect((await branch.getIndex(ctx)).entries).toEqual([]);
    read.mockImplementation(async () => { throw new Error('PRIVATE_ERROR_FROM_STORAGE'); });
    await expect(branch.getIndex(ctx)).rejects.toThrow('Memory authorization unavailable');
  } finally {
    repository.close(); const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
