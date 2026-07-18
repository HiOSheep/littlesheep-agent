import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionTier, type MemoryWriteIntent } from './types.js';
import { createMemoryV3ExperimentMarker } from './memory-repository.js';
import { createMemoryRepositoryManagementFacade } from './memory-repository/management.js';
import { MemoryRepositoryV3Backend } from './memory-repository/v3-backend.js';
import { resolveMemoryWritePolicy } from './memory-repository/write-policy.js';
import { MemoryAtomRevisionService } from './memory-revision.js';

describe('MemoryAtomRevisionService with the V3 backend', () => {
  const directories: string[] = [];
  const backends: MemoryRepositoryV3Backend[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) backend.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('persists the revised Atom, Catalog row and append-only projection record across restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-revision-backend-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const original = createBackend(dataDir);
    backends.push(original);
    await original.initialize();
    const created = await original.write(intent());
    const atomId = created.node!.id;
    const before = (await original.inspectNodeForManagement(atomId, 'D3'))!.atom!;
    const replacement = {
      title: before.title,
      summary: 'Catalog recovery uses a durable graph-first initialization rule.',
      content: 'The catalog relies on a durable graph projection during recovery initialization.',
      retrievalKeys: ['catalog', 'graph', 'recovery', 'initialization'],
    };
    const proposal = {
      id: 'run:backend:evolve:revision:1',
      action: 'revise' as const,
      basis: 'same-claim-refinement' as const,
      atom: { atomId, expectedRevision: before.revision },
      replacement,
      reason: 'Normalizes the same verified graph-first recovery claim without adding a new fact.',
      evidenceRefs: ['run:backend:verification:1:pass'],
    };
    const service = new MemoryAtomRevisionService({
      management: createMemoryRepositoryManagementFacade(original),
    });

    const [committed] = await service.revise([proposal]);
    const inspected = await original.inspectNodeForManagement(atomId, 'D3');

    expect(committed).toMatchObject({
      status: 'committed',
      committed: true,
      previousRevision: before.revision,
      revision: before.revision + 1,
    });
    expect(inspected?.atom).toMatchObject({
      id: atomId,
      revision: before.revision + 1,
      ...replacement,
      sourceRefs: before.sourceRefs,
      evidenceRefs: before.evidenceRefs,
      entityRefs: before.entityRefs,
      relationRefs: before.relationRefs,
      epistemicStatus: before.epistemicStatus,
      resolutionStatus: before.resolutionStatus,
      confidence: before.confidence,
      importance: before.importance,
    });
    expect(inspected?.atom?.contentHash).not.toBe(before.contentHash);
    expect(inspected?.catalog).toMatchObject({
      atomId,
      revision: before.revision + 1,
      contentHash: inspected!.atom!.contentHash,
    });
    const revisionRecord = inspected?.projectionRecords?.find((record) => (
      record.mutation.kind === 'update'
      && record.event.payload.atomManagement
      && (record.event.payload.atomManagement as { action?: string }).action === 'revise'
    ));
    expect(revisionRecord).toBeDefined();
    expect(revisionRecord?.mutation).toMatchObject({
      kind: 'update',
      atomId,
      expectedRevision: before.revision,
      patch: replacement,
    });
    await expect(original.rawRecordStore.getCommitReceipt(revisionRecord!.id)).resolves.toMatchObject({
      rawRecordId: revisionRecord!.id,
    });

    original.close();
    backends.splice(backends.indexOf(original), 1);
    const restarted = createBackend(dataDir);
    backends.push(restarted);
    await restarted.initialize();
    const restartedInspection = await restarted.inspectNodeForManagement(atomId, 'D3');
    const retryService = new MemoryAtomRevisionService({
      management: createMemoryRepositoryManagementFacade(restarted),
    });
    const [retried] = await retryService.revise([proposal]);

    expect(restartedInspection?.atom).toMatchObject({
      id: atomId,
      revision: before.revision + 1,
      ...replacement,
    });
    expect(restartedInspection?.catalog).toMatchObject({
      atomId,
      revision: before.revision + 1,
      contentHash: restartedInspection!.atom!.contentHash,
    });
    expect(restartedInspection?.projectionRecords?.some((record) => record.id === revisionRecord?.id)).toBe(true);
    expect(retried).toMatchObject({ status: 'noop', committed: false, revision: before.revision + 1 });
  });
});

function createBackend(dataDir: string): MemoryRepositoryV3Backend {
  return new MemoryRepositoryV3Backend({
    dataDir,
    policy: resolveMemoryWritePolicy(),
  });
}

function intent(): MemoryWriteIntent {
  return {
    id: 'memory-revision-backend-intent',
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Catalog recovery requires graph-first initialization',
    content: 'The catalog depends on a durable graph projection during recovery.',
    retrievalKeys: ['catalog', 'graph', 'recovery'],
    sourceRunId: 'run-memory-revision-backend',
    sourceStage: 'tool',
    sourceRefs: ['conversation-source:run-memory-revision-backend:user-message:1'],
    evidenceRefs: ['tool:memory-revision-backend'],
    importance: 0.9,
    confidence: 1,
    reason: 'Verified by the Memory v3 recovery contract.',
    epistemic: {
      domain: 'knowledge',
      statementKind: 'factual-claim',
      epistemicStatus: 'verified',
      authorityScope: { kind: 'tool-evidence', scope: 'global', topics: ['memory-v3'] },
      assertedBy: { kind: 'tool', id: 'memory-revision-backend-test' },
    },
  };
}
