import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingEngine, EmbeddingRequest, EmbeddingResult, MemoryEntity, MemoryRelation } from './contracts.js';
import { MemoryCatalog } from './catalog.js';
import { EmbeddingUnavailableError } from './embedding-engine.js';
import { makeStoredAtom } from './test-fixtures.js';

describe('MemoryCatalog', () => {
  let dataDir: string;
  let catalogs: MemoryCatalog[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-catalog-'));
    catalogs = [];
  });

  afterEach(async () => {
    for (const catalog of catalogs) catalog.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('enforces branch, scope, and subtree boundaries for FTS', () => {
    const catalog = createCatalog();
    const root = makeStoredAtom({ id: 'project-root', title: 'Root', content: 'root memory' });
    const child = makeStoredAtom({ id: 'project-child', parentId: root.id, title: 'SQLite catalog', content: 'alpha searchable catalog' });
    const siblingRoot = makeStoredAtom({ id: 'other-root', scopeKey: 'project-b', title: 'Other root', content: 'alpha other project' });
    const experience = makeStoredAtom({
      id: 'experience-root', domain: 'experience', branch: 'experience', scope: 'global', scopeKey: undefined,
      title: 'Experience', content: 'alpha global experience',
      authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['experience'] },
    });
    for (const atom of [root, child, siblingRoot, experience]) catalog.upsertAtom(atom, `atoms/${atom.id}.json`);

    const projectResults = catalog.searchFts('alpha', {
      branch: 'project', scope: 'project', scopeKey: 'project-a', subtreeRootId: root.id,
    });
    expect(projectResults.map((result) => result.entry.atomId)).toEqual(['project-child']);
    expect(catalog.searchFts('alpha', {
      branch: 'project', scope: 'project', scopeKey: 'project-b',
    }).map((result) => result.entry.atomId)).toEqual(['other-root']);
    expect(() => catalog.searchFts('alpha', { branch: 'project', scope: 'project' }))
      .toThrow(/require scopeKey/i);
  });

  it('uses an explicitly local engine for scoped vector candidates', async () => {
    const engine = makeEngine('local');
    const catalog = createCatalog({ embeddingEngine: engine });
    const memory = makeStoredAtom({ id: 'database', content: 'sqlite database catalog', retrievalKeys: ['database'] });
    const unrelated = makeStoredAtom({ id: 'fruit', content: 'apple fruit', retrievalKeys: ['apple'] });
    catalog.upsertAtom(memory, 'atoms/database.json');
    catalog.upsertAtom(unrelated, 'atoms/fruit.json');
    await catalog.indexEmbedding(memory);
    await catalog.indexEmbedding(unrelated);

    const results = await catalog.searchVector('database', {
      branch: 'project', scope: 'project', scopeKey: 'project-a', limit: 2,
    });
    expect(results[0]?.entry.atomId).toBe('database');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? -1);
  });

  it('never calls a remote embedding engine unless explicitly enabled', async () => {
    const remote = makeEngine('remote');
    const catalog = createCatalog({ embeddingEngine: remote });
    const atom = makeStoredAtom();
    catalog.upsertAtom(atom, 'atoms/root.json');

    await expect(catalog.indexEmbedding(atom)).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(remote.embed).not.toHaveBeenCalled();
  });

  it('marks vectors stale when the local engine version changes', async () => {
    const dbPath = join(dataDir, 'versioned.sqlite');
    const first = createCatalog({ dbPath, embeddingEngine: makeEngine('local', '1') });
    const atom = makeStoredAtom();
    first.upsertAtom(atom, 'atoms/root.json');
    await first.indexEmbedding(atom);
    expect(first.getAtom(atom.id)?.embeddingStatus).toBe('ready');
    first.close();
    catalogs = catalogs.filter((catalog) => catalog !== first);

    const upgraded = createCatalog({ dbPath, embeddingEngine: makeEngine('local', '2') });
    expect(upgraded.getAtom(atom.id)?.embeddingStatus).toBe('stale');
  });

  it('rebuilds a deleted catalog from authoritative atom files', async () => {
    const firstPath = join(dataDir, 'first.sqlite');
    const first = createCatalog({ dbPath: firstPath });
    const root = makeStoredAtom({ id: 'root' });
    const child = makeStoredAtom({ id: 'child', parentId: root.id, content: 'rebuild marker' });
    first.rebuild([
      { atom: root, filePath: 'atoms/root.json' },
      { atom: child, filePath: 'atoms/child.json' },
    ]);
    expect(first.countAtoms()).toBe(2);
    first.close();
    catalogs = catalogs.filter((catalog) => catalog !== first);

    await rm(firstPath, { force: true });
    const rebuilt = createCatalog({ dbPath: firstPath });
    expect(rebuilt.rebuild([
      { atom: root, filePath: 'atoms/root.json' },
      { atom: child, filePath: 'atoms/child.json' },
    ])).toBe(2);
    expect(rebuilt.integrityCheck()).toBe('ok');
    expect(rebuilt.searchFts('rebuild', {
      branch: 'project', scope: 'project', scopeKey: 'project-a', subtreeRootId: root.id,
    })[0]?.entry.atomId).toBe('child');
  });

  it('bounds access and feedback records and rejects unverified positive reinforcement', () => {
    const catalog = createCatalog({ maxAccessRecords: 2, maxFeedbackRecords: 2 });
    const atom = makeStoredAtom();
    catalog.upsertAtom(atom, 'atoms/root.json');
    for (let index = 0; index < 3; index += 1) {
      catalog.recordAccess({
        id: `access-${index}`, atomId: atom.id, runId: 'run', stage: 'decide', path: 'hierarchy',
        matchReason: 'index navigation', enteredContext: true, disclosureLevel: 'D1', tokensUsed: 10,
        accessedAt: `2026-07-15T04:00:0${index}.000Z`,
      });
    }
    expect(catalog.countAccessRecords()).toBe(2);
    expect(() => catalog.recordFeedback({
      id: 'feedback-bad', atomId: atom.id, runId: 'run', outcome: 'useful', verified: false,
      evidenceRefs: [], reason: 'Only accessed.', createdAt: '2026-07-15T04:00:00.000Z',
    })).toThrow(/verification evidence/i);
    for (let index = 0; index < 3; index += 1) {
      catalog.recordFeedback({
        id: `feedback-${index}`, atomId: atom.id, runId: 'run', outcome: 'not-useful', verified: false,
        evidenceRefs: [], reason: 'Not relevant.', createdAt: `2026-07-15T04:00:0${index}.000Z`,
      });
    }
    expect(catalog.countFeedbackRecords()).toBe(2);
    expect(catalog.getAtom(atom.id)?.revision).toBe(1);
  });

  it('rejects implicit cross-scope entity relations', () => {
    const catalog = createCatalog();
    const left = makeEntity('entity-a', 'project-a');
    const right = makeEntity('entity-b', 'project-b');
    catalog.upsertEntity(left);
    catalog.upsertEntity(right);
    const relation: MemoryRelation = {
      version: 1,
      id: 'relation-1',
      fromEntityId: left.id,
      toEntityId: right.id,
      type: 'depends-on',
      scope: 'project',
      scopeKey: 'project-a',
      source: { kind: 'agent', id: 'ls' },
      evidenceRefs: ['test'],
      confidence: 0.5,
      authorityScope: { kind: 'none', scope: 'project', scopeKey: 'project-a', topics: [] },
      relevance: 0.5,
      status: 'proposed',
      resolutionStatus: 'unresolved',
      revision: 1,
      createdAt: '2026-07-15T04:00:00.000Z',
      updatedAt: '2026-07-15T04:00:00.000Z',
    };
    expect(() => catalog.upsertRelation(relation)).toThrow(/cross entity scope boundaries/i);
  });

  it('prevents entity and relation lifecycle changes from leaving dangling atom references', () => {
    const catalog = createCatalog();
    const left = makeEntity('entity-left', 'project-a');
    const right = { ...makeEntity('entity-right', 'project-a'), externalKey: 'project-a:right' };
    catalog.upsertEntity(left);
    catalog.upsertEntity(right);
    const relation = makeRelation(left.id, right.id);
    catalog.upsertRelation(relation);
    const atom = makeStoredAtom({
      id: 'graph-atom',
      entityRefs: [left.id],
      relationRefs: [relation.id],
    });
    catalog.upsertAtom(atom, 'atoms/graph-atom.json');

    expect(catalog.entityReferenceBlockers(left.id)).toEqual({
      atomIds: [atom.id],
      inboundRelationIds: [],
      outboundRelationIds: [relation.id],
    });
    expect(() => catalog.upsertEntity({ ...left, status: 'archived', revision: 2 }))
      .toThrow(/references remain/i);
    expect(() => catalog.upsertRelation({ ...relation, status: 'archived', revision: 2 }))
      .toThrow(/atom references remain/i);

    catalog.upsertAtom(makeStoredAtom({ id: atom.id, entityRefs: [], relationRefs: [] }), 'atoms/graph-atom.json');
    catalog.upsertRelation({ ...relation, status: 'archived', revision: 2 });
    catalog.upsertRelation({ ...relation, status: 'deleted', revision: 3 });
    expect(catalog.purgeRelation(relation.id)).toBe(true);
    catalog.upsertEntity({ ...left, status: 'archived', revision: 2 });
    catalog.upsertEntity({ ...left, status: 'deleted', revision: 3 });
    expect(catalog.purgeEntity(left.id)).toBe(true);
  });

  function createCatalog(options: Partial<ConstructorParameters<typeof MemoryCatalog>[0]> = {}): MemoryCatalog {
    const catalog = new MemoryCatalog({ dataDir, ...options });
    catalogs.push(catalog);
    return catalog;
  }
});

function makeEngine(transport: 'local' | 'remote', version = '1'): EmbeddingEngine {
  const embed = vi.fn(async (request: EmbeddingRequest): Promise<EmbeddingResult> => ({
    descriptor: {
      engineId: `${transport}-test-engine`,
      modelId: 'semantic-test-model',
      version,
      dimensions: 3,
      transport,
    },
    vectors: request.texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes('database') || normalized.includes('sqlite')) return [1, 0, 0];
      if (normalized.includes('apple') || normalized.includes('fruit')) return [0, 1, 0];
      return [0, 0, 1];
    }),
  }));
  return {
    descriptor: {
      engineId: `${transport}-test-engine`,
      modelId: 'semantic-test-model',
      version,
      dimensions: 3,
      transport,
    },
    isAvailable: () => true,
    embed,
  };
}

function makeEntity(id: string, scopeKey: string): MemoryEntity {
  return {
    version: 1,
    id,
    type: 'project',
    owner: { kind: 'user', id: 'user' },
    scope: 'project',
    scopeKey,
    externalKey: scopeKey,
    label: scopeKey,
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt: '2026-07-15T04:00:00.000Z',
    updatedAt: '2026-07-15T04:00:00.000Z',
  };
}

function makeRelation(fromEntityId: string, toEntityId: string): MemoryRelation {
  return {
    version: 1,
    id: 'relation-linked',
    fromEntityId,
    toEntityId,
    type: 'depends-on',
    scope: 'project',
    scopeKey: 'project-a',
    source: { kind: 'agent', id: 'ls' },
    evidenceRefs: ['test'],
    confidence: 0.8,
    authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey: 'project-a', topics: ['graph'] },
    relevance: 0.8,
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: '2026-07-15T04:00:00.000Z',
    updatedAt: '2026-07-15T04:00:00.000Z',
  };
}
