import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryAtomStore } from '../v3/atom-store.js';
import { MemoryCatalog } from '../v3/catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from '../v3/event-journal.js';
import { MemoryRawRecordStore } from '../v3/raw-record-store.js';
import { scoreMemoryCandidate } from '../v3/priority.js';
import { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import { makeAtomInput } from '../v3/test-fixtures.js';
import { MemoryV3AtomManagement } from './v3-atom-management.js';

describe('MemoryV3AtomManagement', () => {
  let dataDir: string;
  let catalog: MemoryCatalog;
  let atomStore: MemoryAtomStore;
  let rawRecordStore: MemoryRawRecordStore;
  let management: MemoryV3AtomManagement;
  let tick: number;
  let now: () => Date;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-atom-management-'));
    tick = Date.parse('2026-07-15T04:00:00.000Z');
    now = () => new Date(tick += 1_000);
    atomStore = new MemoryAtomStore({ dataDir, now });
    catalog = new MemoryCatalog({ dataDir });
    rawRecordStore = new MemoryRawRecordStore({ dataDir, now });
    const coordinator = new MemoryV3StorageCoordinator({
      atomStore,
      catalog,
      rawRecordStore,
      eventJournal: new MemoryEventJournal({ dataDir, now }),
      operationJournal: new MemoryOperationJournal({ dataDir, now }),
    });
    await coordinator.initialize();
    management = new MemoryV3AtomManagement({ atomStore, catalog, coordinator, now });
  });

  afterEach(async () => {
    catalog.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('moves a subtree only inside its branch and scope and rejects hierarchy cycles', async () => {
    await seed('parent-a');
    await seed('parent-b');
    await seed('child', { parentId: 'parent-a' });
    await seed('grandchild', { parentId: 'child' });
    const moved = await management.manage({
      action: 'move', atomId: 'child', expectedRevision: 1, parentNodeId: 'parent-b', reason: 'Reorganize projection.',
    });
    expect(moved.atoms[0]).toMatchObject({ id: 'child', revision: 2, parentId: 'parent-b' });
    expect((await atomStore.read('grandchild'))?.parentId).toBe('child');

    await expect(management.manage({
      action: 'move', atomId: 'parent-b', expectedRevision: 1, parentNodeId: 'grandchild', reason: 'Create a cycle.',
    })).rejects.toThrow(/cycle/iu);

    await seed('other-scope', { scopeKey: 'project-b', authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey: 'project-b', topics: ['repository'] } });
    await expect(management.manage({
      action: 'move', atomId: 'child', expectedRevision: 2, parentNodeId: 'other-scope', reason: 'Cross scope.',
    })).rejects.toThrow(/cannot cross/iu);
  });

  it('merges only compatible leaf projections without strengthening confidence or losing source content', async () => {
    const target = await seed('target', { content: 'Canonical projection.', confidence: 0.61, verifiedUsefulness: { useful: 2, notUseful: 0, conflicts: 0, stale: 0 } });
    const source = await seed('source', { content: 'Original source wording.', retrievalKeys: ['additional-key'], confidence: 0.92, verifiedUsefulness: { useful: 9, notUseful: 0, conflicts: 0, stale: 0 } });
    const merged = await management.manage({
      action: 'merge', atomId: source.id, expectedRevision: source.revision,
      targetAtomId: target.id, targetExpectedRevision: target.revision, reason: 'Same fact projection.',
    });
    const [updatedTarget, updatedSource] = merged.atoms;

    expect(updatedTarget).toMatchObject({
      id: target.id,
      revision: 2,
      content: 'Canonical projection.',
      confidence: 0.61,
      verifiedUsefulness: { useful: 2 },
      mergedFromAtomIds: ['source'],
    });
    expect(updatedTarget?.retrievalKeys).toContain('additional-key');
    expect(updatedSource).toMatchObject({
      id: source.id,
      revision: 2,
      status: 'tombstone',
      content: 'Original source wording.',
      merge: { intoAtomId: target.id, reason: 'Same fact projection.' },
    });
    expect(await rawRecordStore.count()).toBe(1);
    expect((await rawRecordStore.listForAtom(source.id))[0]?.mutation.kind).toBe('merge');
  });

  it('rejects epistemically incompatible atoms and non-leaf merge sources', async () => {
    await seed('fact');
    await seed('suggestion', { statementKind: 'suggestion', epistemicStatus: 'unverified', resolutionStatus: 'proposed' });
    await expect(management.manage({
      action: 'merge', atomId: 'suggestion', expectedRevision: 1,
      targetAtomId: 'fact', targetExpectedRevision: 1, reason: 'Wrong category.',
    })).rejects.toThrow(/epistemic boundary/iu);

    await seed('source-parent');
    await seed('source-child', { parentId: 'source-parent' });
    await seed('leaf-target');
    await expect(management.manage({
      action: 'merge', atomId: 'source-parent', expectedRevision: 1,
      targetAtomId: 'leaf-target', targetExpectedRevision: 1, reason: 'Has children.',
    })).rejects.toThrow(/child atoms/iu);
  });

  it('invalidates retrieval eligibility and restores the exact prior epistemic state after restart', async () => {
    const atom = await seed('lifecycle', { epistemicStatus: 'corroborated', resolutionStatus: 'under-review' });
    const invalidated = (await management.manage({
      action: 'invalidate', atomId: atom.id, expectedRevision: atom.revision, reason: 'Evidence is no longer current.',
    })).atoms[0]!;
    expect(invalidated).toMatchObject({ epistemicStatus: 'superseded', resolutionStatus: 'superseded' });
    expect(scoreMemoryCandidate(priorityInput(invalidated)).eligible).toBe(false);
    await expect(management.manage({
      action: 'invalidate', atomId: atom.id, expectedRevision: invalidated.revision, reason: 'Again.',
    })).rejects.toThrow(/already invalidated/iu);

    catalog.close();
    const restartedStore = new MemoryAtomStore({ dataDir, now });
    await restartedStore.initialize();
    const restarted = await restartedStore.read(atom.id);
    expect(restarted?.invalidation).toMatchObject({
      priorEpistemicStatus: 'corroborated', priorResolutionStatus: 'under-review',
    });
    catalog = new MemoryCatalog({ dataDir });
    const restartedRawRecordStore = new MemoryRawRecordStore({ dataDir, now });
    const coordinator = new MemoryV3StorageCoordinator({
      atomStore: restartedStore, catalog, rawRecordStore: restartedRawRecordStore,
      eventJournal: new MemoryEventJournal({ dataDir, now }),
      operationJournal: new MemoryOperationJournal({ dataDir, now }),
    });
    await coordinator.initialize();
    const restartedManagement = new MemoryV3AtomManagement({ atomStore: restartedStore, catalog, coordinator, now });
    const reactivated = (await restartedManagement.manage({
      action: 'reactivate', atomId: atom.id, expectedRevision: restarted!.revision, reason: 'Evidence restored.',
    })).atoms[0]!;
    expect(reactivated).toMatchObject({
      epistemicStatus: 'corroborated', resolutionStatus: 'under-review', invalidation: null,
    });
    expect(scoreMemoryCandidate(priorityInput(reactivated)).eligible).toBe(true);
  });

  async function seed(id: string, overrides: Parameters<typeof makeAtomInput>[0] = {}) {
    const atom = await atomStore.create(makeAtomInput({ id, ...overrides }));
    catalog.upsertAtom(atom, atomStore.relativePathFor(atom.id)!);
    return atom;
  }
});

function priorityInput(atom: Awaited<ReturnType<MemoryAtomStore['read']>> & object) {
  return {
    atom: atom!, now: '2026-07-15T04:30:00.000Z', scopeMatch: 1, taskRelevance: 1,
    authorityMatch: 1, verifiedUsefulness: 0.5, decayHalfLifeDays: 30,
    routingRelevance: 0.5,
    relationshipRelevance: 0.5,
    requiredByCurrentUser: false, safetyCritical: false,
  };
}
