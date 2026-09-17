import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asSessionId } from '@littlesheep/types';
import { InjectionTier, type MemoryWriteIntent } from './types.js';
import { createMemoryV3ExperimentMarker, MemoryRepository, MemoryWriteService } from './memory-repository.js';
import type { EmbeddingEngine, EmbeddingRequest } from './v3/contracts.js';
import { MemoryService } from './memory-service.js';
import { MemoryTree } from './memory-tree.js';
import { DEFAULT_BRANCH_SPECS, TreeMemoryBranch } from './tree-memory-branch.js';

describe('MemoryService on the Memory v3 repository backend', () => {
  const directories: string[] = [];
  const repositories: MemoryRepository[] = [];

  afterEach(async () => {
    for (const repository of repositories.splice(0)) repository.close();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('uses the unchanged navigation and resource APIs with v3 atom evidence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });

    await service.write(intent());
    await service.beginRun({
      runId: 'run-v3',
      sessionId: asSessionId('session-v3'),
      query: 'What communication preference applies?',
      recentHistory: [],
      workspace: dataDir,
      autoPrime: false,
    });
    const index = await service.branchIndex('run-v3', 'long-term');
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.evidence).toMatchObject({ disclosureLevel: 'D1', atomId: index.entries[0]?.id });
    expect(index.knownState?.references[0]).toMatchObject({ decision: 'adopted' });
    const bounded = await service.expand('run-v3', {
      branchId: 'long-term',
      nodeId: index.entries[0]!.id,
      limit: 5,
      tokenBudget: 64,
    });
    expect(bounded.fragments).toHaveLength(0);
    expect(bounded.knownState.references.find((entry) => entry.atomId === index.entries[0]!.id)?.decision)
      .toBe('excluded');
    const expanded = await service.expand('run-v3', {
      branchId: 'long-term',
      nodeId: index.entries[0]!.id,
      limit: 5,
      tokenBudget: 800,
    });
    expect(expanded.fragments[0]).toMatchObject({
      content: expect.stringContaining('short factual progress updates'),
      metadata: { source: expect.stringMatching(/^memory-v3:atom:/u) },
      evidence: { disclosureLevel: 'D2', statementKind: 'preference' },
    });
    expect(expanded.knownState.references.find((entry) => entry.atomId === index.entries[0]!.id))
      .toMatchObject({ decision: 'adopted', reactivatedCount: 1 });
    const d3 = await service.expand('run-v3', {
      branchId: 'long-term',
      nodeId: index.entries[0]!.id,
      disclosureLevel: 'D3',
      limit: 5,
      tokenBudget: 800,
    });
    expect(d3.fragments[0]?.content).toContain('D3 source and audit history');

    const catalog = new DatabaseSync(repository.indexPath, { readOnly: true });
    try {
      const count = catalog.prepare('SELECT COUNT(*) AS count FROM atom_access').get() as { count: number };
      expect(Number(count.count)).toBeGreaterThanOrEqual(4);
    } finally {
      catalog.close();
    }

    await writeFile(join(dataDir, 'AGENTS.md'), 'Always verify results.', 'utf8');
    await service.loadBootstrapFiles(dataDir);
    expect(await service.rootIndex()).toContain('AGENTS.md');
    expect(Object.values((await service.getManagementSnapshot()).document.resources))
      .toEqual(expect.arrayContaining([expect.objectContaining({ title: 'AGENTS.md' })]));
  });

  it('keeps branch-scoped FTS evidence epistemically explicit and blocks navigation bypass', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-search-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });
    await service.write(suggestionIntent(dataDir));
    await service.beginRun({
      runId: 'run-search',
      sessionId: asSessionId('session-search'),
      query: 'Should we use cobalt deployment?',
      recentHistory: [],
      workspace: dataDir,
      autoPrime: false,
    });

    await expect(service.deepSearch('run-search', {
      branchId: 'project', query: 'cobalt deployment', tokenBudget: 800,
    })).rejects.toThrow(/branch_index.*expand/iu);

    const index = await service.branchIndex('run-search', 'project');
    expect(index.entries[0]?.evidence).toMatchObject({
      disclosureLevel: 'D1', statementKind: 'suggestion', epistemicStatus: 'unverified',
    });
    const navigation = await service.expand('run-search', {
      branchId: 'project', nodeId: index.entries[0]!.id, tokenBudget: 64,
    });
    expect(navigation.fragments).toHaveLength(0);
    const result = await service.deepSearch('run-search', {
      branchId: 'project', query: 'cobalt deployment', tokenBudget: 800,
    });
    expect(result.fragments[0]?.evidence).toMatchObject({
      retrievalPath: 'fts', statementKind: 'suggestion', epistemicStatus: 'unverified',
    });
    expect(result.fragments[0]?.content).toContain('adoption does not verify truth');
  });

  it('uses only the provisioned local vector engine inside an already expanded branch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-vector-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const engine = semanticTestEngine();
    const first = new MemoryRepository({ dataDir, backend: 'v3', v3: { embeddingEngine: engine } });
    repositories.push(first);
    await first.initialize();
    await first.write({
      ...intent(),
      id: 'service-v3-vector-memory',
      summary: 'Nebula release convention',
      content: 'The verified release convention is called nebula.',
      retrievalKeys: ['nebula', 'release'],
      reason: 'Verified tool evidence.',
      epistemic: {
        domain: 'knowledge',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['release'] },
        assertedBy: { kind: 'tool', id: 'test' },
        evidenceRefs: ['tool:test'],
      },
    });
    first.close();

    const repository = new MemoryRepository({ dataDir, backend: 'v3', v3: { embeddingEngine: engine } });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });
    await service.beginRun({
      runId: 'run-vector', sessionId: asSessionId('session-vector'), query: 'galaxy',
      recentHistory: [], workspace: dataDir,
      autoPrime: false,
    });
    const embeddingCallsBeforeIndex = vi.mocked(engine.embed).mock.calls.length;
    const index = await service.branchIndex('run-vector', 'long-term');
    expect(engine.embed).toHaveBeenCalledTimes(embeddingCallsBeforeIndex);
    await service.expand('run-vector', {
      branchId: 'long-term', nodeId: index.entries[0]!.id, tokenBudget: 64,
    });
    const result = await service.deepSearch('run-vector', {
      branchId: 'long-term', query: 'galaxy', tokenBudget: 800,
    });
    expect(vi.mocked(engine.embed).mock.calls.length).toBeGreaterThan(embeddingCallsBeforeIndex);
    expect(result.fragments[0]?.evidence?.retrievalPath).toBe('vector');
    expect(result.fragments[0]?.content).toContain('nebula');
  });

  it('reports the embeddings a repeated write reused instead of re-embedding', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-embedding-reuse-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const engine = semanticTestEngine();
    const repository = new MemoryRepository({ dataDir, backend: 'v3', v3: { embeddingEngine: engine } });
    repositories.push(repository);
    await repository.initialize();

    const payload = {
      ...intent(),
      id: 'service-v3-embedding-reuse',
      summary: 'Nebula release convention',
      content: 'The verified release convention is called nebula.',
    };
    const first = await repository.write(payload);
    const second = await repository.write(payload);

    // The first write needs new embedding work; the unchanged rewrite reuses it.
    expect(first.embeddingReuse?.queued).toBeGreaterThan(0);
    expect(second.embeddingReuse).toMatchObject({ reused: 1, queued: 0 });
  });

  // HC-12: a forgotten/corrected fact must not be revived by later maintenance evidence.
  it('does not let a maintenance write revive a tombstoned fact from the same conversation source', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });

    const sourceRef = 'conversation-source:run-forget:user-message:message-1';
    const original = await service.write({
      ...intent(),
      id: 'forget-original',
      summary: 'Project codename is ORCHID',
      content: 'The project codename is ORCHID.',
      sourceRefs: [sourceRef],
    });
    expect(original.decision).toBe('created');

    const deleted = await service.manageNode(original.node!.id, 'delete', 'User asked to forget this.');
    expect(deleted).toBeTruthy();

    const revived = await service.write({
      ...intent(),
      id: 'forget-candidate',
      summary: 'Remembered project codename',
      content: 'The project codename is ORCHID again.',
      sourceRefs: [sourceRef],
      sourceStage: 'maintenance',
    });
    expect(revived.decision).toBe('rejected');
    expect(revived.reason).toMatch(/revoked|tombstone|supersed/iu);
    const nodes = await repository.listNodes('long-term');
    expect(nodes.some((node) => node.summary === 'Remembered project codename')).toBe(false);
  });

  // HC-12: an invalidated (superseded) fact is equally protected, not only a deleted one.
  it('does not let a maintenance write revive an invalidated fact from the same conversation source', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });

    const sourceRef = 'conversation-source:run-invalidated:user-message:message-1';
    const original = await service.write({
      ...intent(),
      id: 'invalidate-original',
      summary: 'Project codename is ORCHID',
      content: 'The project codename is ORCHID.',
      sourceRefs: [sourceRef],
    });
    expect(original.decision).toBe('created');
    const inspected = await repository.management.inspectNode(original.node!.id, 'D3');
    await repository.management.manageAtom({
      action: 'invalidate',
      atomId: original.node!.id,
      expectedRevision: inspected!.atom!.revision,
      reason: 'User invalidated the codename.',
    });

    const revived = await service.write({
      ...intent(),
      id: 'invalidate-candidate',
      summary: 'Remembered project codename',
      content: 'The project codename is ORCHID again.',
      sourceRefs: [sourceRef],
      sourceStage: 'maintenance',
    });
    expect(revived.decision).toBe('rejected');
    expect(revived.reason).toMatch(/revoked|tombstone|supersed/iu);
    expect((await repository.listNodes('long-term')).some((node) => node.summary === 'Remembered project codename'))
      .toBe(false);
  });

  // HC-04: revocation blocks automatic revival but must not block an explicit re-authorization.
  it('allows an explicit re-authorization to create a new valid version after invalidation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });

    const sourceRef = 'conversation-source:run-reauth:user-message:message-1';
    const original = await service.write({
      ...intent(),
      id: 'reauth-original',
      summary: 'Project codename is ORCHID',
      content: 'The project codename is ORCHID.',
      sourceRefs: [sourceRef],
    });
    const inspected = await repository.management.inspectNode(original.node!.id, 'D3');
    await repository.management.manageAtom({
      action: 'invalidate',
      atomId: original.node!.id,
      expectedRevision: inspected!.atom!.revision,
      reason: 'User invalidated the old codename.',
    });

    const reauthorized = await service.write({
      ...intent(),
      id: 'reauth-explicit',
      summary: 'Project codename is ORCHID (re-confirmed by the user)',
      content: 'The user explicitly re-confirmed that the project codename is ORCHID.',
      sourceRefs: [sourceRef],
      sourceStage: 'evolve',
    });
    expect(reauthorized.decision).toBe('created');
    expect(reauthorized.node?.id).toBeTruthy();
    expect((await repository.listNodes('long-term')).some((node) => node.id === reauthorized.node!.id)).toBe(true);
  });

  // HC-11: an identical project fact in two workspaces must not merge or leak across scopes.
  it('keeps a same-named project fact separate across workspace scopes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });

    const projectIntent = (workspaceScope: string) => ({
      ...intent(),
      id: `same-name-${workspaceScope}`,
      branch: 'project' as const,
      parentNodeId: 'project:root',
      scope: 'project' as const,
      scopeKey: workspaceScope,
      sourceRefs: [`conversation-source:run-${workspaceScope}:user-message:message-1`],
    });
    const first = await service.write(projectIntent('C:/workspace/a'));
    const second = await service.write(projectIntent('C:/workspace/b'));

    expect(first.decision).toBe('created');
    expect(second.decision).toBe('created');
    expect(first.node!.id).not.toBe(second.node!.id);
    const nodesA = await repository.listNodes('project', 'C:/workspace/a');
    const nodesB = await repository.listNodes('project', 'C:/workspace/b');
    expect(nodesA.map((node) => node.id)).toContain(first.node!.id);
    expect(nodesA.map((node) => node.id)).not.toContain(second.node!.id);
    expect(nodesB.map((node) => node.id)).toContain(second.node!.id);
    expect(nodesB.map((node) => node.id)).not.toContain(first.node!.id);
  });

  // HC-12: raw source recall can label sources whose atom was revoked.
  it('labels a conversation source as revoked once its atom is invalidated', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-service-v3-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    repositories.push(repository);
    await repository.initialize();
    const tree = new MemoryTree({ rootIndexMaxChars: 900, totalRunTokenBudget: 2_000, perBranchTokenBudget: 1_200 });
    for (const spec of DEFAULT_BRANCH_SPECS) tree.register(new TreeMemoryBranch({ repository, ...spec }));
    const writer = new MemoryWriteService({ repository, invalidate: (branch) => tree.invalidateBranch(branch) });
    const service = new MemoryService({ tree, repository, writer, dataDir, rootIndexMaxChars: 900 });

    const revokedRef = 'conversation-source:run-revoked:user-message:message-1';
    const activeRef = 'conversation-source:run-active:user-message:message-2';
    const written = await service.write({
      ...intent(),
      id: 'revocation-source',
      summary: 'Fact that will be revoked',
      content: 'This fact will be revoked by the user.',
      sourceRefs: [revokedRef],
    });
    const active = await service.write({
      ...intent(),
      id: 'revocation-active',
      summary: 'Fact that stays active',
      content: 'This fact stays active.',
      sourceRefs: [activeRef],
    });

    await expect(service.conversationSourceRevocations([revokedRef, activeRef]))
      .resolves.toEqual({ status: 'ok', revoked: [] });

    const inspected = await repository.management.inspectNode(written.node!.id, 'D3');
    await repository.management.manageAtom({
      action: 'invalidate',
      atomId: written.node!.id,
      expectedRevision: inspected!.atom!.revision,
      reason: 'User forgot this fact.',
    });

    await expect(service.conversationSourceRevocations([revokedRef, activeRef]))
      .resolves.toEqual({ status: 'ok', revoked: [revokedRef] });
    expect(active.node).toBeTruthy();
  });
});

function intent(): MemoryWriteIntent {
  return {
    id: 'service-v3-preference',
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'User prefers concise engineering updates',
    content: 'Use short factual progress updates and avoid unnecessary ceremony.',
    retrievalKeys: ['preference', 'communication'],
    sourceRunId: 'run-write',
    sourceStage: 'evolve',
    importance: 0.9,
    confidence: 0.9,
    reason: 'Explicit user preference.',
  };
}

function suggestionIntent(scopeKey: string): MemoryWriteIntent {
  return {
    id: 'service-v3-suggestion',
    branch: 'project',
    parentNodeId: 'project:root',
    scope: 'project',
    scopeKey,
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Consider cobalt deployment',
    content: 'A user suggested using cobalt deployment for this project.',
    retrievalKeys: ['cobalt', 'deployment'],
    sourceRunId: 'run-write-suggestion',
    sourceStage: 'evolve',
    sourceRefs: ['conversation-source:run-write-suggestion:user-message:message-suggestion'],
    importance: 0.8,
    confidence: 0.6,
    reason: 'User suggestion, not verified fact.',
    epistemic: {
      domain: 'project',
      statementKind: 'suggestion',
      epistemicStatus: 'unverified',
      authorityScope: { kind: 'user-self', scope: 'project', scopeKey, topics: ['design'] },
      assertedBy: { kind: 'user', id: 'user' },
      evidenceRefs: ['user:message-suggestion'],
    },
  };
}

function semanticTestEngine(): EmbeddingEngine {
  const descriptor = {
    engineId: 'local-test', modelId: 'semantic-test', version: '1', dimensions: 2, transport: 'local' as const,
  };
  return {
    descriptor,
    isAvailable: () => true,
    embed: vi.fn(async (request: EmbeddingRequest) => ({
      descriptor,
      vectors: request.texts.map((text) => /nebula|galaxy/iu.test(text) ? [1, 0] : [0, 1]),
    })),
  };
}
