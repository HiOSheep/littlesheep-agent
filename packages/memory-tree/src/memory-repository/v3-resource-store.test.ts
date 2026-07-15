import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionTier, type MemoryResourceRegistration } from '../types.js';
import { MemoryCatalog } from '../v3/catalog.js';
import { makeStoredAtom } from '../v3/test-fixtures.js';
import { MemoryV3GraphStore } from '../v3/graph-store.js';
import { MemoryV3RepositoryLedger } from './v3-ledger.js';
import { memoryV3ResourceEntityId, MemoryV3ResourceStore } from './v3-resource-store.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import { createMemoryV3ExperimentMarker } from '../memory-repository.js';

describe('MemoryV3ResourceStore', () => {
  let dataDir: string;
  let catalog: MemoryCatalog;
  let ledger: MemoryV3RepositoryLedger;
  let graphStore: MemoryV3GraphStore;
  let store: MemoryV3ResourceStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-resource-'));
    await createMemoryV3ExperimentMarker(dataDir);
    catalog = new MemoryCatalog({ dataDir });
    ledger = new MemoryV3RepositoryLedger({ dataDir });
    await ledger.initialize();
    graphStore = new MemoryV3GraphStore({ dataDir, catalog });
    await graphStore.initialize();
    store = new MemoryV3ResourceStore({ dataDir, catalog, graphStore, ledger, policy: resolveMemoryWritePolicy() });
    await store.initialize();
  });

  afterEach(async () => {
    catalog.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stores metadata only and reconciles missing and removed resources', async () => {
    const value = resource();
    await store.replaceGroup(value.registryGroup, [value]);
    expect(await store.list({ tier: InjectionTier.T0_CORE })).toEqual([value]);
    expect(JSON.stringify(await store.snapshotResources())).not.toContain('body that must not be copied');

    await store.replaceGroup(value.registryGroup, []);
    expect(await store.get(value.id)).toMatchObject({ status: 'missing' });
    await store.replaceGroup(value.registryGroup, [], { staleMode: 'remove' });
    expect(await store.get(value.id)).toBeUndefined();
  });

  it('initializes lazily before the first mutation without recursively waiting on its own lock', async () => {
    store = new MemoryV3ResourceStore({ dataDir, catalog, graphStore, ledger, policy: resolveMemoryWritePolicy() });
    const value = resource({ id: 'lazy-initialization' });
    await expect(store.replaceGroup(value.registryGroup, [value])).resolves.toEqual([value]);
    expect(await store.get(value.id)).toEqual(value);
  }, 1_000);

  it('preserves disablement, rebinds a stable resource, and restores audits after restart', async () => {
    const value = resource({
      id: 'workspace-rule',
      tier: InjectionTier.T1_ESSENTIAL,
      branch: 'project',
      scope: 'workspace',
      scopeKey: dataDir,
      registryGroup: 'workspace-docs:test',
      source: { kind: 'file', path: join(dataDir, 'rules.md') },
    });
    await store.replaceGroup(value.registryGroup, [value]);
    await store.manage(value.id, 'disable');
    await store.replaceGroup(value.registryGroup, [{ ...value, updatedAt: '2026-07-15T10:00:00.000Z' }]);
    expect(await store.get(value.id)).toMatchObject({ status: 'disabled' });
    const moved = join(dataDir, 'architecture-principles.md');
    await store.rebind(value.id, { sourcePath: moved, title: 'architecture-principles.md', status: 'active' });
    await store.manage(value.id, 'restore');

    store = new MemoryV3ResourceStore({ dataDir, catalog, graphStore, ledger, policy: resolveMemoryWritePolicy() });
    await store.initialize();
    expect(await store.get(value.id)).toMatchObject({ status: 'active', source: { path: moved } });
    expect((await store.listAudit(value.id)).map((record) => record.action)).toEqual(['restore', 'rebind', 'disable']);
  });

  it('rejects duplicate authoritative physical sources', async () => {
    const first = resource({ id: 'one', tier: InjectionTier.T2_RELEVANT, registryGroup: 'one' });
    await store.replaceGroup('one', [first]);
    await expect(store.replaceGroup('two', [{ ...first, id: 'two', registryGroup: 'two' }]))
      .rejects.toThrow('Conflicting authoritative memory resources');
  });

  it('projects semantic resource kinds to stable entity types', async () => {
    const cases = [
      ['user-profile', 'user'],
      ['agent-instructions', 'rule'],
      ['knowledge', 'concept'],
      ['project-memory-projection', 'project'],
      ['skill', 'skill'],
      ['taskbook', 'task'],
    ] as const;
    const resources = cases.map(([kind], index) => resource({
      id: `entity-type-${kind}`,
      kind,
      tier: InjectionTier.T2_RELEVANT,
      source: { kind: 'memory-node', id: `source-${index}` },
      registryGroup: 'entity-types',
    }));
    await store.replaceGroup('entity-types', resources);
    for (const [index, [, expectedType]] of cases.entries()) {
      const entity = await graphStore.getEntity(memoryV3ResourceEntityId(resources[index]!));
      expect(entity?.type).toBe(expectedType);
    }
  });

  it('keeps run and session resource entity identities distinct', () => {
    const session = resource({ id: 'session-scope', scope: 'session', scopeKey: 'same-key' });
    const run = resource({ id: 'run-scope', scope: 'run', scopeKey: 'same-key' });
    expect(memoryV3ResourceEntityId(run)).not.toBe(memoryV3ResourceEntityId(session));
  });

  it('recovers a captured resource transaction and blocks removal of referenced entities', async () => {
    const value = resource({ id: 'recovered' });
    await ledger.captureTransaction('resource-test-recovery', 'resource-mutation', {
      upserts: [value], removals: [], audits: [],
    });
    store = new MemoryV3ResourceStore({ dataDir, catalog, graphStore, ledger, policy: resolveMemoryWritePolicy() });
    await store.initialize();
    expect(await store.get(value.id)).toEqual(value);
    expect(await ledger.listOutstandingTransactions()).toEqual([]);

    const entityId = memoryV3ResourceEntityId(value);
    const atom = makeStoredAtom({
      id: 'resource-reference',
      domain: 'knowledge',
      branch: 'long-term',
      scope: 'global',
      scopeKey: undefined,
      entityRefs: [entityId],
    });
    catalog.upsertAtom(atom, 'atoms/resource-reference.json');
    await store.manage(value.id, 'disable');
    await expect(store.manage(value.id, 'remove')).rejects.toThrow(/cannot be removed while its entity is referenced/i);
  });
});

function resource(overrides: Partial<MemoryResourceRegistration> = {}): MemoryResourceRegistration {
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
    source: { kind: 'file', path: 'D:/data/AGENTS.md', contentHash: 'sha256:test' },
    indexKeys: ['agents', 'rules'],
    status: 'active',
    registryGroup: 'bootstrap',
    registeredAt: '2026-07-15T09:00:00.000Z',
    updatedAt: '2026-07-15T09:00:00.000Z',
    ...overrides,
  };
}
