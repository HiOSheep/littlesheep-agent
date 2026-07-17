import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  EmbeddingEngine,
  EmbeddingRequest,
  EmbeddingResult,
  MemoryAtom,
  MemoryEntity,
  MemoryRelation,
} from './contracts.js';
import { MemoryCatalog } from './catalog.js';
import { EmbeddingUnavailableError } from './embedding-engine.js';
import { memoryAtomContentHash } from './atom-store.js';
import { memoryAtomEmbeddingHash } from './catalog-helpers.js';
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
    const db = new DatabaseSync(catalog.dbPath);
    const namespaces = db.prepare('SELECT DISTINCT vector_namespace FROM atom_vectors').all() as Array<{
      vector_namespace: string;
    }>;
    db.close();
    expect(namespaces).toEqual([{ vector_namespace: 'memory-atom' }]);
  });

  it('reuses one prepared query vector across scoped catalog searches', async () => {
    const engine = makeEngine('local');
    const catalog = createCatalog({ embeddingEngine: engine });
    const memory = makeStoredAtom({ id: 'prepared-database', content: 'sqlite database catalog' });
    catalog.upsertAtom(memory, 'atoms/prepared-database.json');
    await catalog.indexEmbedding(memory);

    const prepared = await catalog.prepareVectorQuery('database');
    const options = { branch: 'project' as const, scope: 'project' as const, scopeKey: 'project-a', limit: 2 };
    expect(catalog.searchPreparedVector(prepared, options)[0]?.entry.atomId).toBe(memory.id);
    expect(catalog.searchPreparedVector(prepared, options)[0]?.entry.atomId).toBe(memory.id);

    const queryCalls = vi.mocked(engine.embed).mock.calls
      .filter(([request]) => request.purpose === 'query');
    expect(queryCalls).toHaveLength(1);
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

  it('upgrades a v7 catalog with ready vectors to semantic embedding hashes', async () => {
    const dbPath = join(dataDir, 'legacy-v7.sqlite');
    const engine = makeEngine('local', '1');
    const first = createCatalog({ dbPath, embeddingEngine: engine });
    const atom = makeStoredAtom({ id: 'legacy-semantic-hash', content: 'semantic hash migration' });
    first.upsertAtom(atom, 'atoms/legacy-semantic-hash.json');
    await first.indexEmbedding(atom);
    first.close();
    catalogs = catalogs.filter((catalog) => catalog !== first);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      DROP INDEX IF EXISTS idx_atoms_activation;
      ALTER TABLE atom_vectors DROP COLUMN embedding_hash;
      ALTER TABLE atoms DROP COLUMN embedding_hash;
      ALTER TABLE atoms DROP COLUMN activation_score;
      ALTER TABLE atoms DROP COLUMN activation_updated_at;
      PRAGMA user_version = 7;
    `);
    legacy.close();

    const upgraded = createCatalog({ dbPath, embeddingEngine: makeEngine('local', '1') });
    const db = new DatabaseSync(dbPath);
    const row = db.prepare(`
      SELECT atom.embedding_hash AS atom_hash, vector.embedding_hash AS vector_hash
      FROM atoms atom JOIN atom_vectors vector ON vector.atom_id = atom.atom_id
      WHERE atom.atom_id = ?
    `).get(atom.id) as { atom_hash: string; vector_hash: string };
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.close();

    expect(row.atom_hash).toBe(memoryAtomEmbeddingHash(atom));
    expect(row.vector_hash).toBe(row.atom_hash);
    expect(version.user_version).toBe(9);
    expect(upgraded.getAtom(atom.id)?.embeddingStatus).toBe('ready');
    expect(upgraded.getAtom(atom.id)).toMatchObject({
      activationScore: 0.25,
      activationUpdatedAt: atom.updatedAt,
    });
  });

  it('upgrades a v6 vector table before creating the namespace index', async () => {
    const dbPath = join(dataDir, 'legacy-v6.sqlite');
    const engine = makeEngine('local', '1');
    const first = createCatalog({ dbPath, embeddingEngine: engine });
    const atom = makeStoredAtom({ id: 'legacy-vector', content: 'legacy vector memory' });
    first.upsertAtom(atom, 'atoms/legacy-vector.json');
    await first.indexEmbedding(atom);
    first.close();
    catalogs = catalogs.filter((catalog) => catalog !== first);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      DROP INDEX IF EXISTS idx_vectors_namespace_engine;
      ALTER TABLE atom_vectors RENAME TO atom_vectors_v7;
      CREATE TABLE atom_vectors (
        atom_id TEXT PRIMARY KEY REFERENCES atoms(atom_id) ON DELETE CASCADE,
        engine_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO atom_vectors (
        atom_id, engine_id, model_id, engine_version, dimensions, embedding, content_hash, updated_at
      ) SELECT
        atom_id, engine_id, model_id, engine_version, dimensions, embedding, content_hash, updated_at
      FROM atom_vectors_v7;
      DROP TABLE atom_vectors_v7;
      PRAGMA user_version = 6;
    `);
    legacy.close();

    const upgraded = createCatalog({ dbPath, embeddingEngine: makeEngine('local', '1') });
    const db = new DatabaseSync(dbPath);
    const columns = db.prepare('PRAGMA table_info(atom_vectors)').all() as unknown as Array<{ name: string }>;
    const vector = db.prepare('SELECT vector_namespace FROM atom_vectors WHERE atom_id = ?')
      .get(atom.id) as { vector_namespace: string };
    const indexes = db.prepare('PRAGMA index_list(atom_vectors)').all() as unknown as Array<{ name: string }>;
    db.close();

    expect(columns.map((column) => column.name)).toContain('vector_namespace');
    expect(vector.vector_namespace).toBe('memory-atom');
    expect(indexes.map((index) => index.name)).toContain('idx_vectors_namespace_engine');
    expect(upgraded.getAtom(atom.id)?.embeddingStatus).toBe('ready');
  });

  it('upgrades a v5 relation table before persisting conversation source refs', () => {
    const dbPath = join(dataDir, 'legacy-v5.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE relations (
        relation_id TEXT PRIMARY KEY,
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_key TEXT,
        source_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        authority_scope_json TEXT NOT NULL,
        relevance REAL NOT NULL,
        effective_at TEXT,
        expires_at TEXT,
        status TEXT NOT NULL,
        resolution_status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const catalog = createCatalog({ dbPath });
    const left = makeEntity('legacy-left', 'project-a');
    const right = { ...makeEntity('legacy-right', 'project-a'), externalKey: 'project-a:legacy-right' };
    catalog.upsertEntity(left);
    catalog.upsertEntity(right);
    catalog.upsertRelation(makeRelation(left.id, right.id));
    catalog.close();
    catalogs = catalogs.filter((candidate) => candidate !== catalog);

    const upgraded = new DatabaseSync(dbPath);
    const columns = upgraded.prepare('PRAGMA table_info(relations)').all() as unknown as Array<{ name: string }>;
    const row = upgraded.prepare(`
      SELECT source_refs_json FROM relations WHERE relation_id = ?
    `).get('relation-linked') as { source_refs_json: string };
    const version = upgraded.prepare('PRAGMA user_version').get() as { user_version: number };
    upgraded.close();

    expect(columns.map((column) => column.name)).toContain('source_refs_json');
    expect(JSON.parse(row.source_refs_json)).toEqual(['conversation-source:run-1:assistant-reply']);
    expect(version.user_version).toBe(9);
  });

  it('keeps a continuous activation projection and can build a hot fallback order', () => {
    const catalog = createCatalog();
    const cold = makeStoredAtom({
      id: 'activation-cold',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2026-07-15T05:00:00.000Z',
      lastUsefulAt: undefined,
      routingFeedback: undefined,
      verifiedUsefulness: { useful: 0, notUseful: 0, conflicts: 0, stale: 0 },
    });
    const hot = makeStoredAtom({
      id: 'activation-hot',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2026-07-15T05:00:00.000Z',
      lastUsefulAt: '2026-07-15T05:00:00.000Z',
      routingFeedback: {
        useful: 16,
        notUseful: 0,
        conflicts: 0,
        stale: 0,
        effectiveRelevance: 0.94,
        effectiveEvidenceWeight: 16,
        lastOutcome: 'useful',
        lastRoutedAt: '2026-07-15T05:00:00.000Z',
      },
      verifiedUsefulness: { useful: 8, notUseful: 0, conflicts: 0, stale: 0 },
    });
    catalog.upsertAtom(cold, 'atoms/activation-cold.json');
    catalog.upsertAtom(hot, 'atoms/activation-hot.json');

    const ordered = catalog.listAtoms({ status: 'active', orderBy: 'activation', limit: 10 });
    expect(ordered.map((entry) => entry.atomId).slice(0, 2)).toEqual([hot.id, cold.id]);
    expect(ordered[0]?.activationScore).toBeGreaterThan(0.66);
    expect(ordered[1]?.activationScore).toBeLessThan(0.33);
  });

  it('keeps a ready vector for routing-only changes and rebuilds it for semantic changes', async () => {
    const engine = makeEngine('local');
    const catalog = createCatalog({ embeddingEngine: engine });
    const atom = makeStoredAtom({ id: 'embedding-boundary', content: 'stable semantic content' });
    catalog.upsertAtom(atom, 'atoms/embedding-boundary.json');
    await catalog.indexEmbedding(atom);

    const routingOnlyWithoutHash: Omit<MemoryAtom, 'contentHash'> = {
      ...atom,
      revision: atom.revision + 1,
      routingFeedback: {
        useful: 1,
        notUseful: 1,
        conflicts: 0,
        stale: 0,
        lastOutcome: 'not-useful',
        lastRoutedAt: '2026-07-15T05:00:00.000Z',
        recentFeedbackIds: ['feedback-routing-only'],
      },
      feedbackRevision: atom.feedbackRevision + 1,
      updatedAt: '2026-07-15T05:00:00.000Z',
    };
    const routingOnly: MemoryAtom = {
      ...routingOnlyWithoutHash,
      contentHash: memoryAtomContentHash(routingOnlyWithoutHash),
    };
    catalog.upsertAtom(routingOnly, 'atoms/embedding-boundary.json');

    expect(catalog.getAtom(atom.id)).toMatchObject({
      embeddingStatus: 'ready',
      embeddingHash: memoryAtomEmbeddingHash(atom),
    });
    expect(catalog.countEmbeddingWork()).toBe(0);
    expect(engine.embed).toHaveBeenCalledTimes(1);

    const semanticWithoutHash: Omit<MemoryAtom, 'contentHash'> = {
      ...routingOnly,
      revision: routingOnly.revision + 1,
      content: 'changed semantic content',
      updatedAt: '2026-07-15T06:00:00.000Z',
    };
    const semantic: MemoryAtom = {
      ...semanticWithoutHash,
      contentHash: memoryAtomContentHash(semanticWithoutHash),
    };
    catalog.upsertAtom(semantic, 'atoms/embedding-boundary.json');

    expect(catalog.getAtom(atom.id)?.embeddingStatus).toBe('pending');
    expect(catalog.countEmbeddingWork()).toBe(1);
    await catalog.indexEmbedding(semantic);
    expect(engine.embed).toHaveBeenCalledTimes(2);
  });

  it('drops vectors for inactive atoms and requeues an atom when it is restored', async () => {
    const engine = makeEngine('local');
    const catalog = createCatalog({ embeddingEngine: engine });
    const atom = makeStoredAtom({ id: 'embedding-lifecycle', content: 'active semantic memory' });
    catalog.upsertAtom(atom, 'atoms/embedding-lifecycle.json');
    await catalog.indexEmbedding(atom);

    const archivedWithoutHash: Omit<MemoryAtom, 'contentHash'> = {
      ...atom,
      revision: atom.revision + 1,
      status: 'archived',
      updatedAt: '2026-07-15T07:00:00.000Z',
    };
    const archived: MemoryAtom = {
      ...archivedWithoutHash,
      contentHash: memoryAtomContentHash(archivedWithoutHash),
    };
    catalog.upsertAtom(archived, 'atoms/embedding-lifecycle.json');

    expect(catalog.getAtom(atom.id)?.embeddingStatus).toBe('disabled');
    expect(catalog.countEmbeddingWork()).toBe(0);
    const inspection = new DatabaseSync(catalog.dbPath, { readOnly: true });
    expect(inspection.prepare('SELECT COUNT(*) AS count FROM atom_vectors WHERE atom_id = ?')
      .get(atom.id)).toMatchObject({ count: 0 });
    inspection.close();

    const restoredWithoutHash: Omit<MemoryAtom, 'contentHash'> = {
      ...archived,
      revision: archived.revision + 1,
      status: 'active',
      updatedAt: '2026-07-15T08:00:00.000Z',
    };
    const restored: MemoryAtom = {
      ...restoredWithoutHash,
      contentHash: memoryAtomContentHash(restoredWithoutHash),
    };
    catalog.upsertAtom(restored, 'atoms/embedding-lifecycle.json');

    expect(catalog.getAtom(atom.id)?.embeddingStatus).toBe('pending');
    expect(catalog.countEmbeddingWork()).toBe(1);
    await catalog.indexEmbedding(restored);
    expect(catalog.getAtom(atom.id)?.embeddingStatus).toBe('ready');
    expect(engine.embed).toHaveBeenCalledTimes(2);
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

  it('bounds access and feedback records and rejects positive routing without traceable use evidence', () => {
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
    })).toThrow(/traceable use evidence/i);
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
      sourceRefs: ['conversation-source:run-1:assistant-reply'],
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

    expect(catalog.relationRelevanceForAtoms([atom.id, 'missing-atom'], '2026-07-15T05:00:00.000Z'))
      .toEqual(new Map([[atom.id, relation.relevance]]));

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

  it('routes only trusted one-hop relation candidates inside the selected branch, scope, and subtree', () => {
    const catalog = createCatalog();
    const root = makeStoredAtom({ id: 'route-root', entityRefs: [], relationRefs: [] });
    const outsideRoot = makeStoredAtom({ id: 'outside-root', entityRefs: [], relationRefs: [] });
    const entities = [
      makeEntity('entity-route-feature', 'project-a'),
      { ...makeEntity('entity-route-policy', 'project-a'), externalKey: 'project-a:policy' },
      { ...makeEntity('entity-route-similar', 'project-a'), externalKey: 'project-a:similar' },
      { ...makeEntity('entity-route-expired', 'project-a'), externalKey: 'project-a:expired' },
      { ...makeEntity('entity-route-weak', 'project-a'), externalKey: 'project-a:weak' },
      { ...makeEntity('entity-route-outside', 'project-a'), externalKey: 'project-a:outside' },
    ];
    for (const entity of entities) catalog.upsertEntity(entity);
    const [feature, policy, similar, expired, weak, outside] = entities;
    const relations: MemoryRelation[] = [
      { ...makeRelation(feature!.id, policy!.id), id: 'relation-route-dependency' },
      { ...makeRelation(feature!.id, similar!.id), id: 'relation-route-similar', type: 'similar-to' },
      {
        ...makeRelation(feature!.id, expired!.id),
        id: 'relation-route-expired',
        expiresAt: '2026-07-15T04:30:00.000Z',
      },
      {
        ...makeRelation(feature!.id, weak!.id),
        id: 'relation-route-weak',
        confidence: 0.2,
      },
      { ...makeRelation(feature!.id, outside!.id), id: 'relation-route-outside' },
    ];
    for (const relation of relations) catalog.upsertRelation(relation);
    const atoms = [
      root,
      outsideRoot,
      makeStoredAtom({ id: 'route-seed', parentId: root.id, entityRefs: [feature!.id], relationRefs: [] }),
      makeStoredAtom({ id: 'route-required', parentId: root.id, entityRefs: [policy!.id], relationRefs: [] }),
      makeStoredAtom({ id: 'route-similar', parentId: root.id, entityRefs: [similar!.id], relationRefs: [] }),
      makeStoredAtom({ id: 'route-expired', parentId: root.id, entityRefs: [expired!.id], relationRefs: [] }),
      makeStoredAtom({ id: 'route-weak', parentId: root.id, entityRefs: [weak!.id], relationRefs: [] }),
      makeStoredAtom({ id: 'route-outside', parentId: outsideRoot.id, entityRefs: [outside!.id], relationRefs: [] }),
    ];
    for (const atom of atoms) catalog.upsertAtom(atom, `atoms/${atom.id}.json`);

    const candidates = catalog.listRelationRoutingCandidates(['route-seed'], {
      branch: 'project',
      subtreeRootId: root.id,
      limit: 10,
    }, '2026-07-15T05:00:00.000Z');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      seedAtomId: 'route-seed',
      entry: { atomId: 'route-required' },
      relationId: 'relation-route-dependency',
      relationType: 'depends-on',
      direction: 'outbound',
    });
    expect(candidates[0]!.routeStrength).toBeGreaterThan(0.55);
  });

  it('uses relation direction when routing replacements', () => {
    const catalog = createCatalog();
    const replacement = makeEntity('entity-replacement-new', 'project-a');
    const old = { ...makeEntity('entity-replacement-old', 'project-a'), externalKey: 'project-a:old' };
    catalog.upsertEntity(replacement);
    catalog.upsertEntity(old);
    catalog.upsertRelation({
      ...makeRelation(replacement.id, old.id),
      id: 'relation-replaces-old',
      type: 'replaces',
    });
    const atoms = [
      makeStoredAtom({ id: 'replacement-new', entityRefs: [replacement.id], relationRefs: [] }),
      makeStoredAtom({ id: 'replacement-old', entityRefs: [old.id], relationRefs: [] }),
    ];
    for (const atom of atoms) catalog.upsertAtom(atom, `atoms/${atom.id}.json`);

    expect(catalog.listRelationRoutingCandidates(['replacement-old'], {
      branch: 'project', limit: 10,
    }, '2026-07-15T05:00:00.000Z').map((candidate) => candidate.entry.atomId))
      .toEqual(['replacement-new']);
    expect(catalog.listRelationRoutingCandidates(['replacement-new'], {
      branch: 'project', limit: 10,
    }, '2026-07-15T05:00:00.000Z'))
      .toEqual([]);
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
    sourceRefs: ['conversation-source:run-1:assistant-reply'],
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
