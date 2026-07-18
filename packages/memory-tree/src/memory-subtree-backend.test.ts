import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { InjectionTier, type MemoryWriteIntent } from './types.js';
import type { MemoryEntity, MemoryRelation } from './v3/contracts.js';
import { createMemoryV3ExperimentMarker } from './memory-repository.js';
import { createMemoryRepositoryManagementFacade } from './memory-repository/management.js';
import { MemoryRepositoryV3Backend } from './memory-repository/v3-backend.js';
import { resolveMemoryWritePolicy } from './memory-repository/write-policy.js';
import { MemoryAtomSubtreeService } from './memory-subtree.js';

describe('MemoryAtomSubtreeService with the V3 backend', () => {
  const directories: string[] = [];
  const backends: MemoryRepositoryV3Backend[] = [];

  afterEach(async () => {
    for (const backend of backends.splice(0)) backend.close();
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('moves only the root and restores descendants, relation, audit and noop recovery after restart', async () => {
    const dataDir = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'ls-memory-subtree-'));
    directories.push(dataDir);
    await createMemoryV3ExperimentMarker(dataDir);
    let backend = new MemoryRepositoryV3Backend({ dataDir, policy: resolveMemoryWritePolicy() });
    backends.push(backend);
    await backend.initialize();

    const storageScopeKey = await backend.ledger.storageScopeKey('project', 'project-subtree');
    const rootEntity = entity('entity:subtree-root', storageScopeKey);
    const parentEntity = entity('entity:subtree-parent', storageScopeKey);
    await backend.graphStore.upsertEntity(rootEntity);
    await backend.graphStore.upsertEntity(parentEntity);
    const relation = parentRelation(rootEntity.id, parentEntity.id, storageScopeKey);
    await backend.graphStore.upsertRelation(relation);

    const oldParent = await writeAtom(backend, fixture('subtree-old-parent', 'project:root', 'project-subtree'));
    const newParent = await writeAtom(backend, {
      ...fixture('subtree-new-parent', 'project:root', 'project-subtree'),
      entityRefs: [parentEntity.id],
    });
    const root = await writeAtom(backend, {
      ...fixture('subtree-root', oldParent.id, 'project-subtree'),
      entityRefs: [rootEntity.id],
      relationRefs: [relation.id],
    });
    const child = await writeAtom(backend, fixture('subtree-child', root.id, 'project-subtree'));
    const grandchild = await writeAtom(backend, fixture('subtree-grandchild', child.id, 'project-subtree'));

    const currentRoot = await backend.atomStore.read(root.id);
    const currentParent = await backend.atomStore.read(newParent.id);
    const currentChild = await backend.atomStore.read(child.id);
    const currentGrandchild = await backend.atomStore.read(grandchild.id);
    const service = new MemoryAtomSubtreeService({
      management: createMemoryRepositoryManagementFacade(backend),
    });

    const proposal = {
      id: 'run:subtree:move:1',
      action: 'move-subtree' as const,
      basis: 'explicit-parent-relation' as const,
      root: { atomId: root.id, expectedRevision: currentRoot!.revision },
      parent: { atomId: newParent.id, expectedRevision: currentParent!.revision },
      relationId: relation.id,
      reason: 'The verified ownership relation proves the entire existing semantic subtree belongs here.',
      evidenceRefs: ['run:subtree:verification:1:pass'],
    };
    const [result] = await service.moveSubtrees([proposal]);

    expect(result).toMatchObject({
      status: 'committed',
      committed: true,
      rootAtomId: root.id,
      parentAtomId: newParent.id,
      activeDescendantCount: 2,
    });
    await expect(backend.atomStore.read(root.id)).resolves.toMatchObject({
      parentId: newParent.id,
      revision: currentRoot!.revision + 1,
    });
    await expect(backend.atomStore.read(child.id)).resolves.toMatchObject({
      parentId: root.id,
      revision: currentChild!.revision,
    });
    await expect(backend.atomStore.read(grandchild.id)).resolves.toMatchObject({
      parentId: child.id,
      revision: currentGrandchild!.revision,
    });

    backend.close();
    backends.splice(backends.indexOf(backend), 1);
    backend = new MemoryRepositoryV3Backend({ dataDir, policy: resolveMemoryWritePolicy() });
    backends.push(backend);
    await backend.initialize();

    const restored = await backend.inspectNodeForManagement(root.id, 'D3');
    expect(restored).toMatchObject({
      atom: { id: root.id, parentId: newParent.id, revision: currentRoot!.revision + 1 },
      catalog: { parentId: newParent.id, revision: currentRoot!.revision + 1 },
      history: { atomId: root.id, revision: currentRoot!.revision + 1 },
      activeDescendantCount: 2,
    });
    expect(restored?.projectionRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          payload: { atomManagement: expect.objectContaining({ action: 'move' }) },
        }),
      }),
    ]));
    expect(restored?.neighborhood?.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: relation.id, type: 'belongs-to' }),
    ]));
    await expect(backend.atomStore.read(child.id)).resolves.toMatchObject({
      parentId: root.id,
      revision: currentChild!.revision,
    });

    const retryService = new MemoryAtomSubtreeService({
      management: createMemoryRepositoryManagementFacade(backend),
    });
    await expect(retryService.moveSubtrees([proposal])).resolves.toEqual([
      expect.objectContaining({ status: 'noop', committed: false, activeDescendantCount: 2 }),
    ]);
    expect((await backend.managementStatus()).catalog?.integrity).toBe('ok');
  });
});

function fixture(id: string, parentNodeId: string, scopeKey: string) {
  return {
    id,
    parentNodeId,
    summary: `${id} summary`,
    content: `${id} is part of the subtree integration fixture.`,
    retrievalKeys: ['subtree', id],
    entityRefs: [] as string[],
    relationRefs: [] as string[],
    scopeKey,
    sourceRunId: `run-${id}`,
  };
}

async function writeAtom(
  backend: MemoryRepositoryV3Backend,
  options: ReturnType<typeof fixture>,
) {
  const result = await backend.write({
    id: options.id,
    branch: 'project',
    parentNodeId: options.parentNodeId,
    scope: 'project',
    scopeKey: options.scopeKey,
    tier: InjectionTier.T2_RELEVANT,
    summary: options.summary,
    content: options.content,
    retrievalKeys: options.retrievalKeys,
    sourceRunId: options.sourceRunId,
    sourceStage: 'tool',
    importance: 0.9,
    confidence: 0.95,
    reason: 'The subtree integration fixture is supported by the test setup.',
    epistemic: {
      domain: 'project',
      statementKind: 'factual-claim',
      epistemicStatus: 'verified',
      authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey: options.scopeKey, topics: ['subtree'] },
      assertedBy: { kind: 'tool', id: 'subtree-integration-test' },
      entityRefs: options.entityRefs,
      relationRefs: options.relationRefs,
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
    createdAt: '2026-07-17T09:00:00.000Z',
    updatedAt: '2026-07-17T09:00:00.000Z',
  };
}

function parentRelation(fromEntityId: string, toEntityId: string, scopeKey: string | undefined): MemoryRelation {
  return {
    version: 1,
    id: 'relation:subtree-root-belongs-to-parent',
    fromEntityId,
    toEntityId,
    type: 'belongs-to',
    scope: 'project',
    scopeKey,
    source: { kind: 'tool', id: 'subtree-integration-test' },
    sourceRefs: ['conversation-source:subtree-integration'],
    evidenceRefs: ['tool:subtree-integration'],
    confidence: 0.95,
    authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey, topics: ['subtree'] },
    relevance: 0.9,
    feedbackRevision: 0,
    recentFeedbackIds: [],
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: '2026-07-17T09:00:00.000Z',
    updatedAt: '2026-07-17T09:00:00.000Z',
  };
}
