import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCatalog } from './v3/catalog.js';
import { MemoryV3GraphStore } from './v3/graph-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function entity(id: string, externalKey: string) {
  return {
    version: 1 as const,
    id,
    type: 'concept' as const,
    owner: { kind: 'user' as const, id: 'local-user' },
    scope: 'global' as const,
    externalKey,
    label: externalKey,
    aliases: [],
    status: 'active' as const,
    revision: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
  };
}

function relation(id: string, from: string, to: string) {
  return {
    version: 1 as const,
    id,
    fromEntityId: from,
    toEntityId: to,
    type: 'replaces' as const,
    scope: 'global' as const,
    source: { kind: 'user' as const, id: 'local-user' },
    sourceRefs: ['conversation-source:run-1:user-message:m1'],
    evidenceRefs: ['memory-atom:old@1'],
    confidence: 0.9,
    authorityScope: { kind: 'user-self' as const, scope: 'global' as const, topics: [] },
    relevance: 0.9,
    status: 'active' as const,
    resolutionStatus: 'resolved' as const,
    revision: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
  };
}

describe('graph store relation endpoints', () => {
  it('stores a relation between two existing entities', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-graph-endpoints-'));
    directories.push(dataDir);
    const catalog = new MemoryCatalog({ dataDir });
    const store = new MemoryV3GraphStore({ dataDir, catalog });
    await store.initialize();

    const from = entity('memory-entity:concept:replacement', 'replacement');
    const to = entity('memory-entity:concept:superseded', 'superseded');
    await store.upsertEntity(from);
    await store.upsertEntity(to);

    await expect(store.upsertRelation(relation('memory-relation:probe', from.id, to.id)))
      .resolves.toMatchObject({ id: 'memory-relation:probe', fromEntityId: from.id, toEntityId: to.id });
    expect(await store.getRelation('memory-relation:probe')).toMatchObject({ status: 'active' });
    catalog.close();
  });

  it('refuses a self-relation by name, and a relation with a missing endpoint', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-graph-endpoints-'));
    directories.push(dataDir);
    const catalog = new MemoryCatalog({ dataDir });
    const store = new MemoryV3GraphStore({ dataDir, catalog });
    await store.initialize();

    const from = entity('memory-entity:concept:replacement', 'replacement');
    await store.upsertEntity(from);

    // A self-relation collapses to one row and cannot express a direction.
    await expect(store.upsertRelation(relation('memory-relation:self', from.id, from.id)))
      .rejects.toThrow(/two distinct entities/u);
    await expect(store.upsertRelation(relation(
      'memory-relation:missing',
      from.id,
      'memory-entity:concept:missing',
    ))).rejects.toThrow(/endpoints must both exist/u);
    catalog.close();
  });
});
