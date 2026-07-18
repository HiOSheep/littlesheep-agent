import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InjectionTier, type MemoryWriteIntent } from './types.js';
import type { MemoryEntity, MemoryRelation } from './v3/contracts.js';
import { createMemoryV3ExperimentMarker } from './memory-repository.js';
import { createMemoryRepositoryManagementFacade } from './memory-repository/management.js';
import { MemoryRepositoryV3Backend } from './memory-repository/v3-backend.js';
import { resolveMemoryWritePolicy } from './memory-repository/write-policy.js';
import { MemoryAtomCorrectionService } from './memory-correction.js';

describe('MemoryAtomCorrectionService with the V3 backend', () => {
  const directories: string[] = [];
  const backends: MemoryRepositoryV3Backend[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) backend.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  it('persists supersession, Catalog state, projection proof and noop recovery across restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-correction-backend-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    const original = createBackend(dataDir);
    backends.push(original);
    await original.initialize();

    const storageScopeKey = await original.ledger.storageScopeKey('project', 'project-correction');
    const oldEntity = entity('entity:remote-policy', storageScopeKey);
    const replacementEntity = entity('entity:local-policy', storageScopeKey);
    await original.graphStore.upsertEntity(oldEntity);
    await original.graphStore.upsertEntity(replacementEntity);
    const relation = replacementRelation(replacementEntity.id, oldEntity.id, storageScopeKey);
    await original.graphStore.upsertRelation(relation);

    const oldNode = await writeAtom(original, {
      id: 'correction-old-policy',
      summary: 'The project requires remote embeddings.',
      content: 'The memory catalog must call a remote embedding service.',
      retrievalKeys: ['remote embedding', 'memory catalog'],
      entityId: oldEntity.id,
      relationId: relation.id,
      sourceRunId: 'run-correction-old-policy',
    });
    const replacementNode = await writeAtom(original, {
      id: 'correction-new-policy',
      summary: 'The project requires local embeddings only.',
      content: 'The memory catalog must use the bundled local embedding model and make no network request.',
      retrievalKeys: ['local embedding', 'offline', 'memory catalog'],
      entityId: replacementEntity.id,
      relationId: relation.id,
      sourceRunId: 'run-correction-new-policy',
    });
    const before = (await original.inspectNodeForManagement(oldNode.id, 'D3'))!.atom!;
    const replacementBefore = (await original.inspectNodeForManagement(replacementNode.id, 'D3'))!.atom!;
    const proposal = {
      id: 'run:backend:evolve:correction:1',
      action: 'supersede' as const,
      basis: 'evidence-backed-correction' as const,
      superseded: { atomId: oldNode.id, expectedRevision: before.revision },
      replacement: { atomId: replacementNode.id, expectedRevision: replacementBefore.revision },
      relationId: relation.id,
      reason: 'Verified runtime evidence proves that the local-only policy replaces the older remote policy.',
      evidenceRefs: ['run:backend:verification:1:pass'],
    };
    const service = new MemoryAtomCorrectionService({
      management: createMemoryRepositoryManagementFacade(original),
    });

    const [committed] = await service.resolve([proposal]);
    const inspected = await original.inspectNodeForManagement(oldNode.id, 'D3');
    const replacementAfter = await original.inspectNodeForManagement(replacementNode.id, 'D3');

    expect(committed).toMatchObject({
      status: 'committed',
      committed: true,
      previousRevision: before.revision,
      revision: before.revision + 1,
    });
    expect(inspected?.atom).toMatchObject({
      id: oldNode.id,
      revision: before.revision + 1,
      title: before.title,
      summary: before.summary,
      content: before.content,
      sourceRefs: before.sourceRefs,
      evidenceRefs: before.evidenceRefs,
      entityRefs: before.entityRefs,
      relationRefs: before.relationRefs,
      epistemicStatus: 'superseded',
      resolutionStatus: 'superseded',
      supersession: {
        byAtomId: replacementNode.id,
        relationId: relation.id,
        priorEpistemicStatus: before.epistemicStatus,
        priorResolutionStatus: before.resolutionStatus,
      },
    });
    expect(replacementAfter?.atom).toEqual(replacementBefore);
    expect(inspected?.catalog).toMatchObject({
      atomId: oldNode.id,
      revision: before.revision + 1,
      epistemicStatus: 'superseded',
      resolutionStatus: 'superseded',
    });
    const correctionRecord = inspected?.projectionRecords?.find((record) => (
      record.mutation.kind === 'update'
      && record.event.payload.atomManagement
      && (record.event.payload.atomManagement as { action?: string }).action === 'supersede'
    ));
    expect(correctionRecord).toBeDefined();
    expect(correctionRecord?.mutation).toMatchObject({
      kind: 'update',
      atomId: oldNode.id,
      expectedRevision: before.revision,
      patch: {
        epistemicStatus: 'superseded',
        resolutionStatus: 'superseded',
        supersession: {
          byAtomId: replacementNode.id,
          relationId: relation.id,
        },
      },
    });
    await expect(original.rawRecordStore.getCommitReceipt(correctionRecord!.id)).resolves.toMatchObject({
      rawRecordId: correctionRecord!.id,
    });

    original.close();
    backends.splice(backends.indexOf(original), 1);
    const restarted = createBackend(dataDir);
    backends.push(restarted);
    await restarted.initialize();
    const restored = await restarted.inspectNodeForManagement(oldNode.id, 'D3');
    const retryService = new MemoryAtomCorrectionService({
      management: createMemoryRepositoryManagementFacade(restarted),
    });
    const [retried] = await retryService.resolve([proposal]);

    expect(restored?.atom).toMatchObject({
      id: oldNode.id,
      revision: before.revision + 1,
      content: before.content,
      epistemicStatus: 'superseded',
      supersession: { byAtomId: replacementNode.id, relationId: relation.id },
    });
    expect(restored?.catalog).toMatchObject({
      atomId: oldNode.id,
      revision: before.revision + 1,
      epistemicStatus: 'superseded',
    });
    expect(restored?.projectionRecords?.some((record) => record.id === correctionRecord?.id)).toBe(true);
    expect(restored?.neighborhood?.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: relation.id, type: 'replaces' }),
    ]));
    expect(retried).toMatchObject({ status: 'noop', committed: false, revision: before.revision + 1 });
    expect((await restarted.managementStatus()).catalog?.integrity).toBe('ok');
  });
});

function createBackend(dataDir: string): MemoryRepositoryV3Backend {
  return new MemoryRepositoryV3Backend({ dataDir, policy: resolveMemoryWritePolicy() });
}

async function writeAtom(
  backend: MemoryRepositoryV3Backend,
  options: {
    id: string;
    summary: string;
    content: string;
    retrievalKeys: string[];
    entityId: string;
    relationId: string;
    sourceRunId: string;
  },
) {
  const result = await backend.write({
    id: options.id,
    branch: 'project',
    parentNodeId: 'project:root',
    scope: 'project',
    scopeKey: 'project-correction',
    tier: InjectionTier.T2_RELEVANT,
    summary: options.summary,
    content: options.content,
    retrievalKeys: options.retrievalKeys,
    sourceRunId: options.sourceRunId,
    sourceStage: 'tool',
    sourceRefs: [`conversation-source:${options.sourceRunId}:user-message:1`],
    evidenceRefs: [`tool:${options.sourceRunId}`],
    importance: 0.9,
    confidence: 0.95,
    reason: 'The correction integration fixture is supported by tool evidence.',
    epistemic: {
      domain: 'project',
      statementKind: 'factual-claim',
      epistemicStatus: 'verified',
      authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey: 'project-correction', topics: ['embedding'] },
      assertedBy: { kind: 'tool', id: 'correction-integration-test' },
      entityRefs: [options.entityId],
      relationRefs: [options.relationId],
    },
  } satisfies MemoryWriteIntent);
  if (!result.node) throw new Error(`Fixture atom was not created: ${result.reason}`);
  return result.node;
}

function entity(id: string, scopeKey: string | undefined): MemoryEntity {
  return {
    version: 1,
    id,
    type: 'concept',
    owner: { kind: 'agent', id: 'ls' },
    scope: 'project',
    scopeKey,
    externalKey: id,
    label: id,
    aliases: [],
    status: 'active',
    revision: 1,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}

function replacementRelation(
  fromEntityId: string,
  toEntityId: string,
  scopeKey: string | undefined,
): MemoryRelation {
  return {
    version: 1,
    id: 'relation:local-policy-replaces-remote-policy',
    fromEntityId,
    toEntityId,
    type: 'replaces',
    scope: 'project',
    scopeKey,
    source: { kind: 'tool', id: 'correction-integration-test' },
    sourceRefs: ['conversation-source:correction-integration'],
    evidenceRefs: ['tool:correction-integration'],
    confidence: 0.95,
    authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey, topics: ['embedding'] },
    relevance: 0.9,
    feedbackRevision: 0,
    recentFeedbackIds: [],
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
  };
}
