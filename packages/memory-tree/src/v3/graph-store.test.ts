import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCatalog } from './catalog.js';
import { MemoryV3GraphStore } from './graph-store.js';
import type { MemoryEntity, MemoryRelation } from './contracts.js';

describe('MemoryV3GraphStore', () => {
  let dataDir: string;
  let catalog: MemoryCatalog;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-graph-'));
    catalog = new MemoryCatalog({ dataDir });
  });

  afterEach(async () => {
    catalog.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rebuilds entity and relation catalog projections from authoritative files', async () => {
    const graph = new MemoryV3GraphStore({ dataDir, catalog });
    await Promise.all([graph.initialize(), graph.initialize(), graph.initialize()]);
    const left = entity('left');
    const right = entity('right');
    await graph.upsertEntity(left);
    await graph.upsertEntity(right);
    await graph.upsertRelation(relation(left.id, right.id));
    expect(await graph.countEntities()).toBe(2);
    expect(await graph.countRelations()).toBe(1);

    catalog.close();
    catalog = new MemoryCatalog({ dataDir, dbPath: join(dataDir, 'rebuilt.sqlite') });
    const rebuilt = new MemoryV3GraphStore({ dataDir, catalog });
    await rebuilt.initialize();
    expect(catalog.getEntity(left.id)).toEqual(left);
    expect(catalog.hasRelation('relation')).toBe(true);
  });
});

function entity(id: string): MemoryEntity {
  return {
    version: 1,
    id,
    type: 'concept',
    owner: { kind: 'agent', id: 'ls' },
    scope: 'global',
    externalKey: id,
    label: id,
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
  };
}

function relation(fromEntityId: string, toEntityId: string): MemoryRelation {
  return {
    version: 1,
    id: 'relation',
    fromEntityId,
    toEntityId,
    type: 'references',
    scope: 'global',
    source: { kind: 'tool', id: 'test' },
    sourceRefs: [],
    evidenceRefs: ['test'],
    confidence: 1,
    authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['test'] },
    relevance: 1,
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
  };
}
