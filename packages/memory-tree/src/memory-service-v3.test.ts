import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { asSessionId } from '@littlesheep/types';
import { InjectionTier, type MemoryWriteIntent } from './types.js';
import { createMemoryV3ExperimentMarker, MemoryRepository, MemoryWriteService } from './memory-repository.js';
import type { EmbeddingEngine } from './v3/contracts.js';
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
    const index = await service.branchIndex('run-vector', 'long-term');
    await service.expand('run-vector', {
      branchId: 'long-term', nodeId: index.entries[0]!.id, tokenBudget: 64,
    });
    const result = await service.deepSearch('run-vector', {
      branchId: 'long-term', query: 'galaxy', tokenBudget: 800,
    });
    expect(result.fragments[0]?.evidence?.retrievalPath).toBe('vector');
    expect(result.fragments[0]?.content).toContain('nebula');
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
    sourceRefs: ['user:message-suggestion'],
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
    embed: async (request) => ({
      descriptor,
      vectors: request.texts.map((text) => /nebula|galaxy/iu.test(text) ? [1, 0] : [0, 1]),
    }),
  };
}
