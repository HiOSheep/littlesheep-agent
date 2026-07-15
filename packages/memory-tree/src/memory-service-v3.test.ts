import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId } from '@littlesheep/types';
import { InjectionTier, type MemoryWriteIntent } from './types.js';
import { createMemoryV3ExperimentMarker, MemoryRepository, MemoryWriteService } from './memory-repository.js';
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
    });
    const index = await service.branchIndex('run-v3', 'long-term');
    expect(index.entries).toHaveLength(1);
    const expanded = await service.expand('run-v3', {
      branchId: 'long-term',
      nodeId: index.entries[0]!.id,
      limit: 5,
      tokenBudget: 800,
    });
    expect(expanded.fragments[0]).toMatchObject({
      content: expect.stringContaining('short factual progress updates'),
      metadata: { source: expect.stringMatching(/^memory-v3:atom:/u) },
    });

    await writeFile(join(dataDir, 'AGENTS.md'), 'Always verify results.', 'utf8');
    await service.loadBootstrapFiles(dataDir);
    expect(await service.rootIndex()).toContain('AGENTS.md');
    expect(Object.values((await service.getManagementSnapshot()).document.resources))
      .toEqual(expect.arrayContaining([expect.objectContaining({ title: 'AGENTS.md' })]));
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
