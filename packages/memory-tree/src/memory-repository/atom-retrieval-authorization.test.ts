import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { MemoryRepositoryV3Backend } from './v3-backend.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import { makeAtomInput, makeStoredAtom, TEST_TIME } from '../v3/test-fixtures.js';
import type { EmbeddingEngine, MemoryAtom, MemoryEntity, MemoryRelation } from '../v3/contracts.js';
import { InMemoryOwnershipBindings } from '../memory-ownership-bindings.js';
import { createAtomReadAuthorization, type AtomReadAuthorization } from '../atom-read-authorization.js';
import { bindMemoryAccessGrant, issueMemoryAccessGrant, memoryAccessRootId } from '../memory-access-context.js';

let root: string, backend: MemoryRepositoryV3Backend, store: InMemoryOwnershipBindings, gate: AtomReadAuthorization, current: boolean;
const descriptor = { engineId: 'fixture', modelId: 'fixture', version: '1', dimensions: 3, transport: 'local' as const };
const engine: EmbeddingEngine = { descriptor, isAvailable: () => true,
  embed: async (request) => ({ descriptor, vectors: request.texts.map(() => [1, 0, 0]) }) };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ls-atom-retrieval-'));
  backend = new MemoryRepositoryV3Backend({ dataDir: root, policy: resolveMemoryWritePolicy(), v3: { embeddingEngine: engine } });
  await backend.initialize(); store = new InMemoryOwnershipBindings(); current = true;
  const rootId = memoryAccessRootId(root);
  const context = await bindMemoryAccessGrant(issueMemoryAccessGrant({ rootId, runId: 'r', sessionId: 's', workspace: root,
    current: async () => current, resolve: async () => ({ source: 'host', enforcement: 'enforced', policy: {
      version: 1, revision: 0, runId: 'r', sessionId: 's', principalId: `local:${rootId}`, dataRootId: rootId,
      readMode: 'global', writeMode: 'disabled', selected: [], disabled: [], globalWriteGranted: false } }) }),
    { runId: 'r', sessionId: 's', workspace: root }, rootId);
  gate = createAtomReadAuthorization(context, store);
});
afterEach(async () => {
  backend.close(); const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid fixture cleanup');
  await rm(root, { recursive: true, force: true });
});
async function atom(id: string, parentId?: string, reviewed = true): Promise<MemoryAtom> {
  const result = await backend.atomStore.create(makeAtomInput({ id, branch: 'long-term', scope: 'global', scopeKey: undefined,
    parentId, title: `database catalog ${id}`, summary: 'database catalog policy', content: `database catalog ${id}`,
    authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['catalog'] } }));
  backend.catalog.upsertAtom(result, backend.atomStore.pathFor(result.id, result.branch));
  await backend.catalog.indexEmbedding(result);
  if (reviewed) review(result);
  return result;
}
function review(value: MemoryAtom) {
  const rootId = memoryAccessRootId(root);
  const previous = store.get({ kind: 'atom', id: value.id });
  store.compareAndSet({ version: 1, revision: previous ? previous.revision + 1 : 0, entityRevision: `v3:${value.revision}`,
    target: { kind: 'atom', id: value.id, binding: 'reviewed', scope: 'global', dataRootId: rootId, principalId: `local:${rootId}` } }, previous?.revision);
}
const request = () => ({ branch: 'long-term' as const, scopes: [{ scope: 'global' as const }], query: 'database catalog', limit: 10,
  now: TEST_TIME, authorization: gate });

it('filters FTS/vector/fallback/children/subtree before limits and never discloses pending metadata', async () => {
  await atom('allowed'); await atom('child', 'allowed'); await atom('PRIVATE_ATOM', 'allowed', false);
  const read = vi.spyOn(backend.atomStore, 'read');
  const baseline = await backend.indexMemory(request());
  for (let index = 0; index < 240; index++) {
    const denied = makeStoredAtom({ id: `PRIVATE_POOL_${index}`, branch: 'long-term', scope: 'global', scopeKey: undefined,
      parentId: 'allowed', title: 'database catalog policy', content: 'database catalog policy', updatedAt: '2026-10-14T00:00:00.000Z',
      authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['catalog'] } });
    backend.catalog.upsertAtom(denied, `unreadable/${denied.id}`);
    await backend.catalog.indexEmbedding(denied);
  }
  const after = await backend.indexMemory(request());
  expect(after).toEqual(baseline);
  expect(JSON.stringify(after)).not.toContain('PRIVATE_');
  expect(read.mock.calls.some(([id]) => id.startsWith('PRIVATE_'))).toBe(false);
  const fallback = await backend.indexMemory({ ...request(), query: '' });
  expect(fallback.map((item) => item.atom.id).sort()).toEqual(['allowed', 'child']);
  const children = await backend.indexMemory({ ...request(), parentNodeId: 'allowed' });
  expect(children.map((item) => item.atom.id)).toEqual(['child']);
  for (const mode of ['expand', 'deep-search'] as const) {
    const results = await backend.retrieveMemory({ ...request(), disclosureLevel: 'D2', mode, subtreeRootId: 'allowed' });
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).not.toContain('PRIVATE_');
    expect(results.every((item) => ['allowed', 'child'].includes(item.atom.id))).toBe(true);
  }
  const exact = await backend.retrieveMemory({ ...request(), nodeId: 'PRIVATE_ATOM', mode: 'expand', disclosureLevel: 'D3' });
  expect(exact).toEqual([]);
  expect(await backend.indexMemory({ ...request(), parentNodeId: 'PRIVATE_ATOM' })).toEqual([]);
  expect(await backend.retrieveMemory({ ...request(), subtreeRootId: 'PRIVATE_ATOM', mode: 'deep-search', disclosureLevel: 'D2' })).toEqual([]);
  const vectors = backend.catalog.searchPreparedVector(await backend.catalog.prepareVectorQuery('database'), {
    branch: 'long-term', scope: 'global', limit: 1, authorizedAtomIds: ['allowed'] });
  expect(vectors.map((item) => item.entry.atomId)).toEqual(['allowed']);
});

it('rechecks entity versions at candidate acquisition and materialization and refuses expired authority', async () => {
  const approved = await atom('allowed');
  const changed = await backend.atomStore.update(approved.id, approved.revision, { content: 'PRIVATE_NEW_REVISION' });
  // Deliberately stale derived Catalog: it must not authenticate the changed file.
  expect(await backend.indexMemory(request())).toEqual([]);
  backend.catalog.upsertAtom(changed, backend.atomStore.pathFor(changed.id, changed.branch));
  expect(await backend.indexMemory(request())).toEqual([]);
  review(changed);
  expect((await backend.indexMemory(request())).map((item) => item.atom.id)).toEqual(['allowed']);
  let mutated = false;
  const originalRead = backend.atomStore.read.bind(backend.atomStore);
  vi.spyOn(backend.atomStore, 'read').mockImplementation(async (id) => {
    const value = await originalRead(id);
    if (id === 'allowed' && !mutated) {
      mutated = true; await backend.atomStore.update(id, changed.revision, { content: 'PRIVATE_RACE_REVISION' });
    }
    return value;
  });
  expect(await backend.retrieveMemory({ ...request(), nodeId: 'allowed', mode: 'expand', disclosureLevel: 'D2' })).toEqual([]);
  current = false;
  await expect(backend.indexMemory(request())).rejects.toThrow('authorization unavailable');
});

it('overwrites caller-supplied authorization ids instead of trusting them', async () => {
  await atom('allowed');
  await atom('PRIVATE_ATOM', undefined, false);
  // The sealed gate is the only authority: a forged id list on the request cannot widen it.
  const exact = await backend.retrieveMemory({ ...request(), nodeId: 'PRIVATE_ATOM', authorizedAtomIds: ['PRIVATE_ATOM'],
    mode: 'expand', disclosureLevel: 'D3' });
  expect(exact).toEqual([]);
  const listed = await backend.indexMemory({ ...request(), query: '', authorizedAtomIds: ['PRIVATE_ATOM'] });
  expect(listed.map((item) => item.atom.id)).toEqual(['allowed']);
});

it('constrains actual relation routing candidates before the route limit', async () => {
  const entity = (id: string): MemoryEntity => ({ version: 1, id, type: 'concept', owner: { kind: 'tool', id: 'fixture' }, scope: 'global',
    label: id, aliases: [], status: 'active', revision: 1, createdAt: TEST_TIME, updatedAt: TEST_TIME });
  await backend.graphStore.upsertEntity(entity('seed-entity')); await backend.graphStore.upsertEntity(entity('target-entity'));
  const relation: MemoryRelation = { version: 1, id: 'route', fromEntityId: 'seed-entity', toEntityId: 'target-entity', type: 'depends-on', scope: 'global',
    source: { kind: 'tool', id: 'fixture' }, sourceRefs: [], evidenceRefs: ['tool:fixture'], confidence: 1, relevance: 1,
    authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['catalog'] }, status: 'active', resolutionStatus: 'resolved', revision: 1,
    createdAt: TEST_TIME, updatedAt: TEST_TIME };
  await backend.graphStore.upsertRelation(relation);
  for (const [id, entityId, reviewed] of [['seed', 'seed-entity', true], ['allowed', 'target-entity', true], ['PRIVATE_ROUTE', 'target-entity', false]] as const) {
    const value = await atom(id, undefined, false);
    const changed = await backend.atomStore.update(id, value.revision, { entityRefs: [entityId], relationRefs: ['route'] });
    backend.catalog.upsertAtom(changed, backend.atomStore.pathFor(id, changed.branch));
    if (reviewed) review(changed);
  }
  const routes = backend.catalog.listRelationRoutingCandidates(['seed'], { branch: 'long-term', authorizedAtomIds: ['seed', 'allowed'], limit: 1 }, TEST_TIME);
  expect(routes.map((item) => item.entry.atomId)).toEqual(['allowed']);
  const results = await backend.indexMemory(request());
  expect(JSON.stringify(results)).not.toContain('PRIVATE_ROUTE');
  expect(results.every((item) => !item.neighborhood)).toBe(true);
});
