import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionTier, type MemoryWriteIntent } from '../types.js';
import { MemoryAtomStore } from '../v3/atom-store.js';
import { MemoryCatalog } from '../v3/catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from '../v3/event-journal.js';
import { MemoryV3GraphStore } from '../v3/graph-store.js';
import { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import { MemoryV3RepositoryLedger } from './v3-ledger.js';
import { MemoryV3NodeStore } from './v3-node-store.js';
import { resolveMemoryWritePolicy } from './write-policy.js';
import { createMemoryV3ExperimentMarker } from '../memory-repository.js';

describe('MemoryV3NodeStore', () => {
  let dataDir: string;
  let runtime: Awaited<ReturnType<typeof createRuntime>>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-v3-node-store-'));
    await createMemoryV3ExperimentMarker(dataDir);
    runtime = await createRuntime(dataDir);
  });

  afterEach(async () => {
    runtime.catalog.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates canonical roots and writes classified atoms with durable audit', async () => {
    const roots = await runtime.nodes.snapshotNodes();
    expect(Object.keys(roots).sort()).toEqual(['daily:root', 'experience:root', 'long-term:root', 'project:root']);

    const result = await runtime.nodes.write(intent({
      summary: '用户偏好简洁回复',
      content: '用户明确表示希望工程进度回复简洁。',
    }));
    expect(result).toMatchObject({ decision: 'created', node: { status: 'active', scope: 'global' } });
    const atom = await runtime.atomStore.read(result.node!.id);
    expect(atom).toMatchObject({ domain: 'user', statementKind: 'preference', epistemicStatus: 'reported' });
    expect((await runtime.ledger.snapshot()).writeAudit.at(-1)).toMatchObject({
      decision: 'created', nodeId: result.node!.id,
    });
  });

  it('reinforces only the same epistemic category and never merges a suggestion into a fact', async () => {
    const first = await runtime.nodes.write(intent({ id: 'preference-1' }));
    const reinforced = await runtime.nodes.write(intent({ id: 'preference-2', sourceRunId: 'run-2', confidence: 0.95 }));
    expect(reinforced).toMatchObject({ decision: 'reinforced', node: { id: first.node!.id } });
    expect(reinforced.node?.sourceRunIds).toEqual(['run-1', 'run-2']);

    const suggestion = await runtime.nodes.write(intent({
      id: 'suggestion',
      summary: 'Use SQLite',
      content: 'Use SQLite for the catalog.',
      epistemic: {
        domain: 'project',
        statementKind: 'suggestion',
        epistemicStatus: 'unverified',
        authorityScope: { kind: 'none', scope: 'global', topics: [] },
        assertedBy: { kind: 'agent', id: 'ls' },
      },
    }));
    const fact = await runtime.nodes.write(intent({
      id: 'fact',
      summary: 'Use SQLite',
      content: 'Use SQLite for the catalog.',
      sourceStage: 'tool',
      epistemic: {
        domain: 'project',
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['database'] },
        assertedBy: { kind: 'tool', id: 'sqlite-check' },
      },
    }));
    expect(suggestion.decision).toBe('created');
    expect(fact.decision).toBe('created');
    expect(fact.node?.id).not.toBe(suggestion.node?.id);
  });

  it('queues missing parents and persists management state across restart', async () => {
    const queued = await runtime.nodes.write(intent({ parentNodeId: 'long-term:missing' }));
    expect(queued.decision).toBe('queued');
    expect((await runtime.ledger.snapshot()).recoveryQueue).toHaveLength(1);

    const created = await runtime.nodes.write(intent({ id: 'managed' }));
    await runtime.nodes.manage(created.node!.id, 'promote');
    await runtime.nodes.manage(created.node!.id, 'archive');
    await runtime.nodes.manage(created.node!.id, 'restore');
    await runtime.nodes.manage(created.node!.id, 'delete');
    expect((await runtime.ledger.snapshot()).managementAudit.map((record) => record.action))
      .toEqual(['promote', 'archive', 'restore', 'delete']);

    runtime.catalog.close();
    runtime = await createRuntime(dataDir);
    expect(await runtime.nodes.get(created.node!.id)).toMatchObject({ status: 'deleted' });
  });

  it('keeps atom scope stable while exposing a rebound project path', async () => {
    const created = await runtime.nodes.write(intent({
      id: 'project-rule',
      branch: 'project',
      parentNodeId: 'project:root',
      scope: 'workspace',
      scopeKey: 'D:/old',
      summary: 'Build rule',
      content: 'Use pnpm build.',
      retrievalKeys: ['pnpm', 'build'],
    }));
    expect(await runtime.nodes.countPublicScope('D:/old')).toBe(1);
    await runtime.ledger.rebindScope('D:/old', 'D:/new');
    expect((await runtime.nodes.get(created.node!.id))?.scopeKey).toBe('D:/new');
    expect(await runtime.nodes.list('project', 'D:/new')).toHaveLength(1);
  });
});

async function createRuntime(dataDir: string) {
  const ledger = new MemoryV3RepositoryLedger({ dataDir });
  await ledger.initialize();
  const atomStore = new MemoryAtomStore({ dataDir });
  const eventJournal = new MemoryEventJournal({ dataDir });
  const operationJournal = new MemoryOperationJournal({ dataDir });
  const catalog = new MemoryCatalog({ dataDir });
  const graphStore = new MemoryV3GraphStore({ dataDir, catalog });
  await graphStore.initialize();
  const coordinator = new MemoryV3StorageCoordinator({
    atomStore,
    catalog,
    eventJournal,
    operationJournal,
    onCheckpoint: async (checkpoint, context) => {
      if (checkpoint !== 'catalog-updated') return;
      const record = await eventJournal.get(context.eventId);
      if (record) await ledger.materializeEventAudits(record.event.payload);
    },
  });
  await coordinator.initialize();
  const nodes = new MemoryV3NodeStore({
    atomStore,
    catalog,
    coordinator,
    graphStore,
    ledger,
    policy: resolveMemoryWritePolicy(),
  });
  await nodes.initialize();
  return { ledger, atomStore, eventJournal, operationJournal, catalog, graphStore, coordinator, nodes };
}

function intent(overrides: Partial<MemoryWriteIntent> = {}): MemoryWriteIntent {
  return {
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
