import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmbeddingEngine } from '../v3/contracts.js';
import {
  InjectionTier,
  type MemoryResourceRegistration,
  type MemoryTreeDocument,
  type MemoryWriteIntent,
} from '../types.js';
import { createMemoryV3ExperimentMarker, MemoryRepository } from '../memory-repository.js';
import { MEMORY_V3_EXPERIMENT_MARKER } from './contracts.js';
import { memoryRepositoryLocatorPath } from './repository-locator.js';
import { MemoryRepositoryV3Backend } from './v3-backend.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import {
  MemoryV2ToV3MigrationManager,
  type MemoryV3MigrationFaultPoint,
} from './v3-migration.js';

describe('Memory v2 -> v3 migration', () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('reports a read-only migration preflight with source and capacity evidence', async () => {
    const dataDir = await createDataDir(directories);
    const source = await seedV2(dataDir);
    const manager = new MemoryV2ToV3MigrationManager({
      dataDir,
      availableBytes: async () => 512 * 1024 * 1024,
    });

    const preflight = await manager.preflight();

    expect(preflight).toMatchObject({
      locator: { activeBackend: 'v2' },
      canMigrate: true,
      canResume: false,
      rollbackAvailable: false,
      blockers: [],
      source: {
        nodeCount: publicNodeCount(source),
        resourceCount: Object.keys(source.resources).length,
      },
      storage: { availableBytes: 512 * 1024 * 1024 },
    });
    expect(preflight.storage!.requiredBytes).toBeGreaterThan(0);
    expect(existsSync(memoryRepositoryLocatorPath(dataDir))).toBe(false);
  });

  it('preserves nodes, resources, ledgers, ids, and the untouched v2 rollback authority', async () => {
    const dataDir = await createDataDir(directories);
    const source = await seedV2(dataDir);
    const indexPath = join(dataDir, 'memory-tree', 'index.json');
    const beforeHash = hash(await readFile(indexPath));

    const manager = new MemoryV2ToV3MigrationManager({ dataDir });
    const result = await manager.migrate();

    expect(result.locator).toMatchObject({ activeBackend: 'v3', previousBackend: 'v2' });
    expect(result.migration).toMatchObject({
      nodeCount: publicNodeCount(source),
      resourceCount: Object.keys(source.resources).length,
    });
    expect(hash(await readFile(indexPath))).toBe(beforeHash);
    expect(existsSync(join(dataDir, MEMORY_V3_EXPERIMENT_MARKER))).toBe(false);
    expect(existsSync(join(
      dataDir,
      result.migration.snapshotRelativePath,
      'v2',
      'index.v1-test.backup.json',
    ))).toBe(true);

    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    await repository.initialize();
    const target = await repository.snapshot();
    expect(Object.keys(target.nodes).sort()).toEqual(Object.keys(source.nodes).sort());
    expect(target.writeAudit.map((record) => record.id).sort()).toEqual(source.writeAudit.map((record) => record.id).sort());
    expect(target.managementAudit.map((record) => record.id)).toEqual(source.managementAudit.map((record) => record.id));
    expect(target.resourceManagementAudit.map((record) => record.id)).toEqual(source.resourceManagementAudit.map((record) => record.id));
    expect(target.recoveryQueue.map((record) => record.id)).toEqual(source.recoveryQueue.map((record) => record.id));
    expect(target.schemaMigrations).toEqual(source.schemaMigrations);
    repository.close();

    const rolledBack = await manager.rollback();
    expect(rolledBack.activeBackend).toBe('v2');
    await createMemoryV3ExperimentMarker(dataDir);
    expect(() => new MemoryRepository({ dataDir, backend: 'v3' })).toThrow(/requires an active migration locator/i);
    const v2 = new MemoryRepository({ dataDir, backend: 'v2' });
    expect(Object.keys((await v2.snapshot()).nodes).sort()).toEqual(Object.keys(source.nodes).sort());
    expect(hash(await readFile(indexPath))).toBe(beforeHash);
  });

  it.each([
    'after-snapshot',
    'after-stage-initialized',
    'after-ledger-import',
    'after-atom-write',
    'after-stage-build',
    'after-validation',
    'before-active-v3-commit',
    'after-active-v3-commit',
    'after-locator-commit',
  ] satisfies MemoryV3MigrationFaultPoint[])('recovers idempotently after simulated power loss at %s', async (point) => {
    const dataDir = await createDataDir(directories);
    await seedV2(dataDir);
    let injected = false;
    const interrupted = new MemoryV2ToV3MigrationManager({
      dataDir,
      faultInjector: (candidate) => {
        if (candidate !== point || injected) return;
        injected = true;
        throw Object.assign(new Error(`simulated power loss at ${point}`), { code: 'EIO' });
      },
    });
    await expect(interrupted.migrate()).rejects.toThrow(/simulated power loss/i);

    const resumed = await new MemoryV2ToV3MigrationManager({ dataDir }).migrate();
    expect(resumed.locator.activeBackend).toBe('v3');
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    await repository.initialize();
    expect(publicNodeCount(await repository.snapshot())).toBeGreaterThan(0);
    repository.close();
  });

  it('keeps v2 active after ENOSPC and succeeds when capacity becomes available', async () => {
    const dataDir = await createDataDir(directories);
    await seedV2(dataDir);
    const indexPath = join(dataDir, 'memory-tree', 'index.json');
    const beforeHash = hash(await readFile(indexPath));
    const constrained = new MemoryV2ToV3MigrationManager({ dataDir, availableBytes: async () => 0 });

    await expect(constrained.migrate()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect((await constrained.status()).activeBackend).toBe('v2');
    expect(hash(await readFile(indexPath))).toBe(beforeHash);
    expect(existsSync(join(dataDir, 'memory-tree', 'v3'))).toBe(false);

    const recovered = await new MemoryV2ToV3MigrationManager({ dataDir }).migrate();
    expect(recovered.locator.activeBackend).toBe('v3');
  });

  it('discards a partial staging tree after mid-build ENOSPC', async () => {
    const dataDir = await createDataDir(directories);
    await seedV2(dataDir);
    let injected = false;
    const constrained = new MemoryV2ToV3MigrationManager({
      dataDir,
      faultInjector: (point) => {
        if (point !== 'after-atom-write' || injected) return;
        injected = true;
        throw Object.assign(new Error('simulated disk full during atom creation'), { code: 'ENOSPC' });
      },
    });
    await expect(constrained.migrate()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect((await constrained.status()).activeBackend).toBe('v2');
    await expect(new MemoryV2ToV3MigrationManager({ dataDir }).migrate())
      .resolves.toMatchObject({ locator: { activeBackend: 'v3' } });
  });

  it('refuses automatic rollback after v3 has accepted new authoritative writes', async () => {
    const dataDir = await createDataDir(directories);
    await seedV2(dataDir);
    const manager = new MemoryV2ToV3MigrationManager({ dataDir });
    await manager.migrate();
    const repository = new MemoryRepository({ dataDir, backend: 'v3' });
    await repository.initialize();
    await repository.write(intent({ id: 'post-migration-write', sourceRunId: 'run-after-migration' }));
    repository.close();
    await expect(manager.rollback()).rejects.toThrow(/differs|lose data/i);
    expect((await manager.status()).activeBackend).toBe('v3');
  });

  it('refuses commit when v2 changes after the snapshot instead of creating dual authorities', async () => {
    const dataDir = await createDataDir(directories);
    await seedV2(dataDir);
    const indexPath = join(dataDir, 'memory-tree', 'index.json');
    let changed = false;
    const manager = new MemoryV2ToV3MigrationManager({
      dataDir,
      faultInjector: async (point) => {
        if (point !== 'after-snapshot' || changed) return;
        changed = true;
        const document = JSON.parse(await readFile(indexPath, 'utf8')) as MemoryTreeDocument;
        document.updatedAt = '2026-07-15T11:11:11.000Z';
        await writeFile(indexPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      },
    });
    await expect(manager.migrate()).rejects.toThrow(/changed before the v3 commit/i);
    expect((await manager.status()).activeBackend).toBe('v2');
    expect(existsSync(join(dataDir, 'memory-tree', 'v3'))).toBe(false);
  });

  it.each([
    ['corrupt json', (raw: string) => `${raw.slice(0, 20)}{`],
    ['orphan parent', (raw: string) => mutateDocument(raw, (document) => {
      const child = Object.values(document.nodes).find((node) => !node.isBranchRoot && node.parentNodeId?.includes('root') === false)!;
      const parent = document.nodes[child.parentNodeId!];
      parent!.childIds = parent!.childIds.filter((id) => id !== child.id);
      child.parentNodeId = 'missing-parent';
    })],
    ['duplicate id', (raw: string) => mutateDocument(raw, (document) => {
      const node = Object.values(document.nodes).find((candidate) => !candidate.isBranchRoot)!;
      document.nodes['duplicate-map-key'] = structuredClone(node);
    })],
    ['damaged node', (raw: string) => mutateDocument(raw, (document) => {
      const node = Object.values(document.nodes).find((candidate) => !candidate.isBranchRoot)!;
      node.summary = '';
    })],
  ] as Array<[string, (raw: string) => string]>)('rejects %s without modifying the source or committing v3', async (_label, mutate) => {
    const dataDir = await createDataDir(directories);
    await seedV2(dataDir);
    const indexPath = join(dataDir, 'memory-tree', 'index.json');
    const mutated = mutate(await readFile(indexPath, 'utf8'));
    await writeFile(indexPath, mutated, 'utf8');
    const manager = new MemoryV2ToV3MigrationManager({ dataDir });

    await expect(manager.migrate()).rejects.toThrow();
    expect(await readFile(indexPath, 'utf8')).toBe(mutated);
    expect((await manager.status()).activeBackend).toBe('v2');
    expect(existsSync(join(dataDir, 'memory-tree', 'v3'))).toBe(false);
  });

  it('builds hierarchy and FTS while an explicitly configured local embedding model is unavailable', async () => {
    const dataDir = await createDataDir(directories);
    await seedV2(dataDir);
    const embeddingEngine = unavailableEmbeddingEngine();
    const manager = new MemoryV2ToV3MigrationManager({ dataDir, v3: { embeddingEngine } });
    await expect(manager.migrate()).resolves.toMatchObject({ locator: { activeBackend: 'v3' } });

    const backend = new MemoryRepositoryV3Backend({
      dataDir,
      policy: resolveMemoryWritePolicy(),
      v3: { embeddingEngine },
    });
    await backend.initialize();
    const publicEntries = backend.catalog.listAtoms({ limit: 100_000 })
      .filter((entry) => !entry.atomId.endsWith(':root') && !entry.atomId.startsWith('v3-scope-root:'));
    expect(publicEntries.length).toBeGreaterThan(0);
    expect(publicEntries.every((entry) => entry.embeddingStatus === 'pending')).toBe(true);
    expect(backend.catalog.searchFts('concise', { branch: 'long-term', scope: 'global', limit: 10 }).length).toBeGreaterThan(0);
    backend.close();
  });
});

async function seedV2(dataDir: string): Promise<MemoryTreeDocument> {
  const repository = new MemoryRepository({ dataDir, backend: 'v2' });
  await repository.initialize();
  const parent = await repository.write(intent({ id: 'parent-intent' }));
  const child = await repository.write(intent({
    id: 'child-intent',
    parentNodeId: parent.node!.id,
    summary: 'Concise completion reports',
    content: 'Keep completion reports concise and evidence based.',
    sourceRunId: 'run-child',
  }));
  await repository.manageNode(child.node!.id, 'archive', 'Preserve an archived state through migration.');
  await repository.write(intent({ id: 'queued-intent', parentNodeId: 'long-term:missing' }));
  const value = resource(dataDir);
  await repository.replaceResourceGroup(value.registryGroup, [value]);
  await repository.manageResource(value.id, 'disable', { reason: 'Preserve resource state through migration.' });
  await repository.markMigration({
    id: 'legacy-source-import',
    completedAt: '2026-07-15T10:00:00.000Z',
    sourceCount: 2,
    created: 2,
    merged: 0,
    reinforced: 0,
    rejected: 0,
  });
  repository.close();

  const indexPath = join(dataDir, 'memory-tree', 'index.json');
  const document = JSON.parse(await readFile(indexPath, 'utf8')) as MemoryTreeDocument;
  document.schemaMigrations.push({
    id: 'schema-test',
    fromVersion: 1,
    toVersion: 2,
    startedAt: '2026-07-15T09:59:00.000Z',
    completedAt: '2026-07-15T10:00:00.000Z',
    backupFile: 'index.v1-test.backup.json',
  });
  await writeFile(indexPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await writeFile(join(dataDir, 'memory-tree', 'index.v1-test.backup.json'), '{"version":1}\n', 'utf8');
  return document;
}

function intent(overrides: Partial<MemoryWriteIntent> = {}): MemoryWriteIntent {
  return {
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'User prefers concise engineering updates',
    content: 'Use concise factual progress updates backed by verification.',
    retrievalKeys: ['concise', 'engineering', 'updates'],
    sourceRunId: 'run-parent',
    sourceStage: 'evolve',
    sourceRefs: ['user:preference'],
    importance: 0.9,
    confidence: 0.95,
    reason: 'The user stated the preference explicitly.',
    ...overrides,
  };
}

function resource(dataDir: string): MemoryResourceRegistration {
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
  };
}

function unavailableEmbeddingEngine(): EmbeddingEngine {
  return {
    descriptor: {
      engineId: 'local-unavailable',
      modelId: 'test-local-model',
      version: '1',
      dimensions: 3,
      transport: 'test',
    },
    isAvailable: () => false,
    embed: async () => { throw new Error('Embedding should remain pending while the model is unavailable.'); },
  };
}

async function createDataDir(directories: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-migration-'));
  directories.push(dataDir);
  return dataDir;
}

function mutateDocument(raw: string, mutate: (document: MemoryTreeDocument) => void): string {
  const document = JSON.parse(raw) as MemoryTreeDocument;
  mutate(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

function publicNodeCount(document: MemoryTreeDocument): number {
  return Object.values(document.nodes).filter((node) => !node.isBranchRoot).length;
}

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
