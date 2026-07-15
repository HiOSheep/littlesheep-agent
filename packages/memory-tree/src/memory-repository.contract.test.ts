import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionTier, type MemoryResourceRegistration, type MemoryWriteIntent } from './types.js';
import {
  createMemoryV3ExperimentMarker,
  MEMORY_V3_EXPERIMENT_MARKER,
  MemoryRepository,
  type MemoryRepositoryBackendKind,
} from './memory-repository.js';

describe.each(['v2', 'v3'] as MemoryRepositoryBackendKind[])('MemoryRepository %s contract', (backend) => {
  const directories: string[] = [];
  const repositories: MemoryRepository[] = [];

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  async function create() {
    const dataDir = mkdtempSync(join(tmpdir(), `ls-memory-contract-${backend}-`));
    directories.push(dataDir);
    if (backend === 'v3') await createMemoryV3ExperimentMarker(dataDir);
    const repository = new MemoryRepository({ dataDir, backend });
    repositories.push(repository);
    await repository.initialize();
    return { dataDir, repository };
  }

  it('keeps canonical roots, write/query, duplicate, policy, hierarchy, and management behavior compatible', async () => {
    const { repository } = await create();
    const snapshot = await repository.snapshot();
    expect(Object.keys(snapshot.nodes).sort()).toEqual([
      'daily:root', 'experience:root', 'long-term:root', 'project:root',
    ]);

    const first = await repository.write(intent());
    expect(first).toMatchObject({ decision: 'created', node: { status: 'active', tier: InjectionTier.T2_RELEVANT } });
    expect((await repository.children('long-term:root')).map((node) => node.id)).toContain(first.node!.id);
    const duplicate = await repository.write(intent({ id: 'duplicate', sourceRunId: 'run-2', confidence: 0.95 }));
    expect(duplicate).toMatchObject({ decision: 'reinforced', node: { id: first.node!.id } });

    expect(await repository.write(intent({ id: 't0', tier: InjectionTier.T0_CORE })))
      .toMatchObject({ decision: 'rejected' });
    expect(await repository.write(intent({ id: 'missing', parentNodeId: 'long-term:missing' })))
      .toMatchObject({ decision: 'queued' });

    await repository.manageNode(first.node!.id, 'promote');
    await repository.manageNode(first.node!.id, 'archive');
    expect(await repository.listNodes('long-term')).toHaveLength(0);
    await repository.manageNode(first.node!.id, 'restore');
    await repository.manageNode(first.node!.id, 'delete');
    expect(await repository.getNode(first.node!.id)).toMatchObject({ status: 'deleted' });
    expect((await repository.snapshot()).managementAudit.map((record) => record.action))
      .toEqual(['promote', 'archive', 'restore', 'delete']);
  });

  it('keeps metadata resource lifecycle behavior compatible', async () => {
    const { dataDir, repository } = await create();
    const value = resource(dataDir);
    await repository.replaceResourceGroup(value.registryGroup, [value]);
    expect(await repository.listResources({ tier: InjectionTier.T0_CORE })).toEqual([value]);
    expect(JSON.stringify(await repository.snapshot())).not.toContain('resource body must not be copied');
    await repository.manageResource(value.id, 'disable');
    await repository.replaceResourceGroup(value.registryGroup, [{ ...value, updatedAt: '2026-07-15T12:00:00.000Z' }]);
    expect(await repository.getResource(value.id)).toMatchObject({ status: 'disabled' });
    await repository.manageResource(value.id, 'restore');
    await repository.replaceResourceGroup(value.registryGroup, []);
    expect(await repository.getResource(value.id)).toMatchObject({ status: 'missing' });
    await repository.manageResource(value.id, 'remove');
    expect(await repository.getResource(value.id)).toBeUndefined();
  });

  it('persists state across restart and isolates v2/v3 storage authorities', async () => {
    const { dataDir, repository } = await create();
    const created = await repository.write(intent({ id: 'restart' }));
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);

    const reopened = new MemoryRepository({ dataDir, backend });
    repositories.push(reopened);
    await reopened.initialize();
    expect(await reopened.getNode(created.node!.id)).toMatchObject({ content: created.node!.content });
    if (backend === 'v2') {
      expect(existsSync(join(dataDir, 'memory-tree', 'index.json'))).toBe(true);
      expect(existsSync(join(dataDir, 'memory-tree', 'v3', 'catalog.sqlite'))).toBe(false);
    } else {
      expect(existsSync(join(dataDir, 'memory-tree', 'index.json'))).toBe(false);
      expect(existsSync(join(dataDir, 'memory-tree', 'v3', 'catalog.sqlite'))).toBe(true);
    }
  });

  it('rebinds project nodes, queued writes, and resources idempotently', async () => {
    const { dataDir, repository } = await create();
    const fromPath = join(dataDir, 'Original');
    const toPath = join(dataDir, 'Moved');
    const created = await repository.write(intent({
      id: 'project-node',
      branch: 'project',
      parentNodeId: 'project:root',
      scope: 'workspace',
      scopeKey: fromPath,
      summary: 'Build rule',
      content: 'Use pnpm build.',
      retrievalKeys: ['pnpm', 'build'],
    }));
    await repository.write(intent({
      id: 'queued-project',
      branch: 'project',
      parentNodeId: 'project:missing',
      scope: 'workspace',
      scopeKey: fromPath,
    }));
    const projectResource = resource(dataDir, {
      id: 'project-resource',
      tier: InjectionTier.T1_ESSENTIAL,
      branch: 'project',
      scope: 'workspace',
      scopeKey: fromPath,
      source: { kind: 'file', path: join(fromPath, 'AGENTS.md') },
      registryGroup: 'project-test',
    });
    await repository.replaceResourceGroup(projectResource.registryGroup, [projectResource]);

    await expect(repository.rebindProjectPath(fromPath, toPath)).resolves.toEqual({
      nodeCount: 1, recoveryIntentCount: 1, resourceCount: 1,
    });
    expect((await repository.getNode(created.node!.id))?.scopeKey).toBe(toPath);
    expect((await repository.snapshot()).recoveryQueue[0]?.intent.scopeKey).toBe(toPath);
    expect(await repository.getResource(projectResource.id)).toMatchObject({
      scopeKey: toPath,
      source: { path: join(toPath, 'AGENTS.md') },
    });
    await expect(repository.rebindProjectPath(fromPath, toPath)).resolves.toEqual({
      nodeCount: 0, recoveryIntentCount: 0, resourceCount: 0,
    });
  });

  it('serializes concurrent equivalent writes into one atom or node', async () => {
    const { repository } = await create();
    const [left, right] = await Promise.all([
      repository.write(intent({ id: 'concurrent-left', sourceRunId: 'run-left' })),
      repository.write(intent({ id: 'concurrent-right', sourceRunId: 'run-right' })),
    ]);
    expect([left.decision, right.decision].sort()).toEqual(['created', 'reinforced']);
    const nodes = await repository.listNodes('long-term');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.sourceRunIds.sort()).toEqual(['run-left', 'run-right']);
  });

  it('never allows daily timeline records to rise into T1', async () => {
    const { repository } = await create();
    const rejected = await repository.write(intent({
      id: 'daily-t1',
      branch: 'daily',
      parentNodeId: 'daily:root',
      tier: InjectionTier.T1_ESSENTIAL,
      summary: 'Daily event',
      content: 'A transient run event occurred.',
      retrievalKeys: ['daily', 'event'],
      sourceStage: 'capture',
    }));
    expect(rejected).toMatchObject({ decision: 'rejected' });

    const created = await repository.write(intent({
      id: 'daily-t2',
      branch: 'daily',
      parentNodeId: 'daily:root',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'Daily event',
      content: 'A transient run event occurred.',
      retrievalKeys: ['daily', 'event'],
      sourceStage: 'capture',
    }));
    expect(created.decision).toBe('created');
    await expect(repository.manageNode(created.node!.id, 'promote')).rejects.toThrow(/highest allowed tier/i);
    await expect(repository.changeTier(created.node!.id, InjectionTier.T1_ESSENTIAL)).rejects.toThrow(/daily.*T1/i);
    expect(await repository.getNode(created.node!.id)).toMatchObject({ tier: InjectionTier.T2_RELEVANT });
  });

  it('rejects resource identity conflicts and records an explicit rebind', async () => {
    const { dataDir, repository } = await create();
    const first = resource(dataDir, { id: 'resource-one', registryGroup: 'group-one' });
    await repository.replaceResourceGroup(first.registryGroup, [first]);
    await expect(repository.replaceResourceGroup('group-two', [{
      ...first,
      id: 'resource-two',
      registryGroup: 'group-two',
    }])).rejects.toThrow(/conflict/i);

    const moved = join(dataDir, 'moved', 'AGENTS.md');
    const rebound = await repository.rebindResource(first.id, { sourcePath: moved });
    expect(rebound).toMatchObject({ changed: true, resource: { id: first.id, source: { path: moved } } });
    expect((await repository.listResourceManagementAudit(first.id)).map((record) => record.action)).toContain('rebind');
  });

  it('retries queued writes after their parent becomes available again', async () => {
    const { repository } = await create();
    const parent = await repository.write(intent({
      id: 'recovery-parent',
      summary: 'Recovery parent',
      content: 'Parent memory for a recovery queue contract.',
      retrievalKeys: ['recovery', 'parent'],
    }));
    await repository.manageNode(parent.node!.id, 'archive');
    const queued = await repository.write(intent({
      id: 'recovery-child',
      parentNodeId: parent.node!.id,
      summary: 'Recovery child',
      content: 'Child memory waiting for its parent to return.',
      retrievalKeys: ['recovery', 'child'],
    }));
    expect(queued.decision).toBe('queued');
    await repository.manageNode(parent.node!.id, 'restore');

    const retried = await repository.retryRecoveryQueue();
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ decision: 'created', node: { parentNodeId: parent.node!.id } });
    expect((await repository.snapshot()).recoveryQueue).toHaveLength(0);
  });
});

describe('MemoryRepository backend gate', () => {
  it('refuses v3 on an unmarked data root and keeps v2 as the default', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-memory-backend-gate-'));
    try {
      expect(() => new MemoryRepository({ dataDir, backend: 'v3' })).toThrow(/isolated-data marker/i);
      const repository = new MemoryRepository({ dataDir });
      expect(repository.backendKind).toBe('v2');
      await repository.initialize();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses a malformed or forged v3 experiment marker', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-memory-backend-invalid-gate-'));
    try {
      writeFileSync(join(dataDir, MEMORY_V3_EXPERIMENT_MARKER), '{"version":1}', 'utf8');
      expect(() => new MemoryRepository({ dataDir, backend: 'v3' })).toThrow(/isolated-data marker/i);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function intent(overrides: Partial<MemoryWriteIntent> = {}): MemoryWriteIntent {
  return {
    id: 'intent',
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'User prefers concise engineering updates',
    content: 'Use short factual progress updates and avoid unnecessary ceremony.',
    retrievalKeys: ['user preference', 'communication', 'concise'],
    sourceRunId: 'run-1',
    sourceStage: 'evolve',
    importance: 0.85,
    confidence: 0.9,
    reason: 'The user stated this preference repeatedly and explicitly.',
    ...overrides,
  };
}

function resource(dataDir: string, overrides: Partial<MemoryResourceRegistration> = {}): MemoryResourceRegistration {
  return {
    version: 1,
    id: 'file:agents',
    kind: 'agent-instructions',
    title: 'AGENTS.md',
    description: 'Runtime operating rules.',
    tier: InjectionTier.T0_CORE,
    scope: 'global',
    authority: 'authoritative',
    privacy: 'private',
    source: { kind: 'file', path: join(dataDir, 'AGENTS.md'), contentHash: 'sha256:test' },
    indexKeys: ['agents', 'rules'],
    status: 'active',
    registryGroup: 'bootstrap',
    registeredAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
    ...overrides,
  };
}
