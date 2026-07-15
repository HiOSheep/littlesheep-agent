import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingEngine, EmbeddingRequest, EmbeddingResult, MemoryEntity } from '../v3/contracts.js';
import { InjectionTier, type MemoryWriteIntent } from '../types.js';
import { createMemoryV3ExperimentMarker } from '../memory-repository.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import { MemoryRepositoryV3Backend } from './v3-backend.js';

describe('MemoryRepositoryV3Backend recovery', () => {
  const directories: string[] = [];
  const backends: MemoryRepositoryV3Backend[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) backend.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('restores graph projections before rebuilding atoms that reference entities', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-rebuild-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const original = createBackend(dataDir);
    backends.push(original);
    await original.initialize();

    const entity = testEntity();
    await original.graphStore.upsertEntity(entity);
    const created = await original.write(intent(entity.id));
    expect(created.decision).toBe('created');
    expect(created.node?.id).toBeTruthy();
    original.close();
    backends.splice(backends.indexOf(original), 1);

    const catalogPath = join(dataDir, 'memory-tree', 'v3', 'catalog.sqlite');
    await Promise.all([
      rm(catalogPath, { force: true }),
      rm(`${catalogPath}-wal`, { force: true }),
      rm(`${catalogPath}-shm`, { force: true }),
    ]);

    const rebuilt = createBackend(dataDir);
    backends.push(rebuilt);
    await rebuilt.initialize();
    expect(rebuilt.catalog.getEntity(entity.id)).toEqual(entity);
    expect(await rebuilt.getNode(created.node!.id)).toMatchObject({
      id: created.node!.id,
      content: 'The catalog depends on a durable graph projection.',
    });
  });

  it('indexes a committed atom before a successful write returns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-backend-embedding-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const backend = createBackend(dataDir, localEmbeddingEngine());
    backends.push(backend);
    await backend.initialize();

    const created = await backend.write(intent());

    expect(created.decision).toBe('created');
    expect(backend.catalog.getAtom(created.node!.id)?.embeddingStatus).toBe('ready');
    expect(backend.catalog.countEmbeddingWork()).toBe(0);
    const managementStatus = await backend.managementStatus();
    expect(managementStatus).toMatchObject({
      backendKind: 'v3',
      storageKind: 'atom-catalog',
      retrievalSupported: true,
      catalog: {
        integrity: 'ok',
        embedding: { pending: 0, failed: 0 },
      },
    });
    expect(managementStatus.catalog!.embedding.ready).toBeGreaterThanOrEqual(1);
    await expect(backend.inspectNodeForManagement(created.node!.id, 'D3')).resolves.toMatchObject({
      backendKind: 'v3',
      disclosureLevel: 'D3',
      atom: {
        id: created.node!.id,
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
      },
      catalog: { embeddingStatus: 'ready' },
      envelope: { disclosureLevel: 'D3', epistemicStatus: 'verified' },
      history: { atomId: created.node!.id },
    });
  });
});

function createBackend(dataDir: string, embeddingEngine?: EmbeddingEngine): MemoryRepositoryV3Backend {
  return new MemoryRepositoryV3Backend({
    dataDir,
    policy: resolveMemoryWritePolicy(),
    v3: embeddingEngine ? { embeddingEngine } : undefined,
  });
}

function testEntity(): MemoryEntity {
  return {
    version: 1,
    id: 'concept:durable-graph',
    type: 'concept',
    owner: { kind: 'agent', id: 'ls' },
    scope: 'global',
    externalKey: 'durable-graph',
    label: 'Durable graph',
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
  };
}

function intent(entityId?: string): MemoryWriteIntent {
  return {
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Catalog recovery requires graph-first initialization',
    content: 'The catalog depends on a durable graph projection.',
    retrievalKeys: ['catalog', 'graph', 'recovery'],
    sourceRunId: 'run-graph-recovery',
    sourceStage: 'tool',
    importance: 0.9,
    confidence: 1,
    reason: 'Verified by the Memory v3 recovery contract.',
    epistemic: {
      domain: 'knowledge',
      statementKind: 'factual-claim',
      epistemicStatus: 'verified',
      authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3'] },
      assertedBy: { kind: 'tool', id: 'memory-v3-recovery-test' },
      entityRefs: entityId ? [entityId] : [],
    },
  };
}

function localEmbeddingEngine(): EmbeddingEngine {
  const descriptor = {
    engineId: 'local-backend-test',
    modelId: 'memory-v3-test',
    version: '1',
    dimensions: 3,
    transport: 'local' as const,
  };
  return {
    descriptor,
    isAvailable: () => true,
    embed: async (request: EmbeddingRequest): Promise<EmbeddingResult> => ({
      descriptor,
      vectors: request.texts.map(() => [1, 0, 0]),
    }),
  };
}
