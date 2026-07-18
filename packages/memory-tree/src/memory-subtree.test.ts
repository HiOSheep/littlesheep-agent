import { describe, expect, it, vi } from 'vitest';
import type { MemoryAtom, MemoryRelation, MemoryRelationNeighborhood } from './v3/contracts.js';
import { makeStoredAtom } from './v3/test-fixtures.js';
import type {
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryRepositoryManagementFacade,
} from './memory-repository/management.js';
import {
  MAX_SUBTREE_ACTIVE_DESCENDANTS,
  MemoryAtomSubtreeService,
  type MemoryAtomSubtreeMoveProposal,
} from './memory-subtree.js';

describe('MemoryAtomSubtreeService', () => {
  it('moves one evidenced non-leaf subtree and recognizes a committed retry as a noop', async () => {
    const root = atom('subtree-root', 'old-parent', ['entity:root']);
    const parent = atom('new-parent', 'project:root', ['entity:parent']);
    const child = atom('child', root.id, ['entity:child']);
    const grandchild = atom('grandchild', child.id, ['entity:grandchild']);
    const atoms = atomMap(root, parent, child, grandchild);
    const relation = parentRelation(root, parent);
    const neighborhood = relationNeighborhood(relation);
    const invalidate = vi.fn(async () => undefined);
    const service = new MemoryAtomSubtreeService({
      management: fakeManagement(atoms, {
        descendantCounts: new Map([[root.id, 2]]),
        neighborhoods: new Map([[root.id, neighborhood], [parent.id, neighborhood]]),
      }),
      invalidate,
    });

    const [first] = await service.moveSubtrees([proposal()]);
    const [retried] = await service.moveSubtrees([proposal()]);

    expect(first).toMatchObject({
      status: 'committed',
      committed: true,
      rootAtomId: root.id,
      parentAtomId: parent.id,
      activeDescendantCount: 2,
    });
    expect(atoms.get(root.id)).toMatchObject({ parentId: parent.id, revision: 2 });
    expect(atoms.get(child.id)).toMatchObject({ parentId: root.id, revision: 1 });
    expect(atoms.get(grandchild.id)).toMatchObject({ parentId: child.id, revision: 1 });
    expect(retried).toMatchObject({ status: 'noop', committed: false, activeDescendantCount: 2 });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('recovers an unknown commit outcome without moving descendants again', async () => {
    const root = atom('subtree-root', 'old-parent', ['entity:root']);
    const parent = atom('new-parent', 'project:root', ['entity:parent']);
    const child = atom('child', root.id, ['entity:child']);
    const atoms = atomMap(root, parent, child);
    const relation = parentRelation(root, parent);
    const neighborhood = relationNeighborhood(relation);
    const service = new MemoryAtomSubtreeService({
      management: fakeManagement(atoms, {
        descendantCounts: new Map([[root.id, 1]]),
        neighborhoods: new Map([[root.id, neighborhood], [parent.id, neighborhood]]),
        throwAfterCommitOnce: true,
      }),
    });

    const [uncertain] = await service.moveSubtrees([proposal()]);
    const [recovered] = await service.moveSubtrees([proposal()]);

    expect(uncertain).toMatchObject({ status: 'deferred', committed: false });
    expect(atoms.get(root.id)).toMatchObject({ parentId: parent.id, revision: 2 });
    expect(atoms.get(child.id)).toMatchObject({ parentId: root.id, revision: 1 });
    expect(recovered).toMatchObject({ status: 'noop', committed: false });
  });

  it('rejects leaf and oversized roots and defers when bounded inspection is unavailable', async () => {
    for (const [count, status, reason] of [
      [0, 'rejected', 'leaf hierarchy protocol'],
      [MAX_SUBTREE_ACTIVE_DESCENDANTS + 1, 'rejected', 'automatic limit'],
      [undefined, 'deferred', 'bounded descendant inspection'],
    ] as const) {
      const root = atom('subtree-root', 'old-parent', ['entity:root']);
      const parent = atom('new-parent', 'project:root', ['entity:parent']);
      const relation = parentRelation(root, parent);
      const neighborhood = relationNeighborhood(relation);
      const counts = new Map<string, number>();
      if (count !== undefined) counts.set(root.id, count);
      const service = new MemoryAtomSubtreeService({
        management: fakeManagement(atomMap(root, parent), {
          descendantCounts: counts,
          neighborhoods: new Map([[root.id, neighborhood], [parent.id, neighborhood]]),
        }),
      });

      await expect(service.moveSubtrees([proposal()])).resolves.toEqual([
        expect.objectContaining({ status, reason: expect.stringContaining(reason) }),
      ]);
    }
  });

  it('rejects a relation whose direction does not prove the subtree parent', async () => {
    const root = atom('subtree-root', 'old-parent', ['entity:root']);
    const parent = atom('new-parent', 'project:root', ['entity:parent']);
    const relation = {
      ...parentRelation(root, parent),
      fromEntityId: parent.entityRefs[0]!,
      toEntityId: root.entityRefs[0]!,
    };
    const neighborhood = relationNeighborhood(relation);
    const service = new MemoryAtomSubtreeService({
      management: fakeManagement(atomMap(root, parent), {
        descendantCounts: new Map([[root.id, 2]]),
        neighborhoods: new Map([[root.id, neighborhood], [parent.id, neighborhood]]),
      }),
    });

    await expect(service.moveSubtrees([proposal()])).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('No active, resolved') }),
    ]);
  });
});

function atom(id: string, parentId: string, entityRefs: string[]): MemoryAtom {
  return makeStoredAtom({
    id,
    parentId,
    title: id,
    summary: `${id} subtree projection`,
    content: `${id} participates in the project subtree.`,
    retrievalKeys: [id, 'subtree'],
    entityRefs,
  });
}

function parentRelation(root: MemoryAtom, parent: MemoryAtom): MemoryRelation {
  return {
    version: 1,
    id: 'relation:subtree-belongs-to-parent',
    fromEntityId: root.entityRefs[0]!,
    toEntityId: parent.entityRefs[0]!,
    type: 'belongs-to',
    scope: 'project',
    scopeKey: 'project-a',
    source: { kind: 'tool', id: 'test-tool' },
    sourceRefs: ['conversation-source:subtree'],
    evidenceRefs: ['tool:subtree'],
    confidence: 0.9,
    authorityScope: root.authorityScope,
    relevance: 0.9,
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: root.createdAt,
    updatedAt: root.updatedAt,
  };
}

function relationNeighborhood(relation: MemoryRelation): MemoryRelationNeighborhood {
  return { entities: [], relations: [relation], truncated: false };
}

function proposal(): MemoryAtomSubtreeMoveProposal {
  return {
    id: 'run:test:subtree:1',
    action: 'move-subtree',
    basis: 'explicit-parent-relation',
    root: { atomId: 'subtree-root', expectedRevision: 1 },
    parent: { atomId: 'new-parent', expectedRevision: 1 },
    relationId: 'relation:subtree-belongs-to-parent',
    reason: 'The active ownership relation proves this complete subtree belongs under the destination parent.',
    evidenceRefs: ['run:test:verification:1:pass'],
  };
}

function atomMap(...atoms: MemoryAtom[]): Map<string, MemoryAtom> {
  return new Map(atoms.map((candidate) => [candidate.id, structuredClone(candidate)]));
}

function fakeManagement(
  atoms: Map<string, MemoryAtom>,
  options: {
    neighborhoods?: Map<string, MemoryRelationNeighborhood>;
    descendantCounts?: Map<string, number>;
    throwAfterCommitOnce?: boolean;
  } = {},
): MemoryRepositoryManagementFacade {
  let threwAfterCommit = false;
  return {
    status: async () => ({ backendKind: 'v3', storageKind: 'atom-catalog', retrievalSupported: true }),
    inspectNode: async (nodeId, disclosureLevel) => {
      const candidate = atoms.get(nodeId);
      return candidate ? {
        backendKind: 'v3' as const,
        nodeId,
        disclosureLevel,
        atom: structuredClone(candidate),
        neighborhood: options.neighborhoods?.get(nodeId),
        activeDescendantCount: options.descendantCounts?.get(nodeId),
      } : undefined;
    },
    manageAtom: async (request) => {
      const result = applyMove(atoms, request);
      if (options.throwAfterCommitOnce && !threwAfterCommit) {
        threwAfterCommit = true;
        throw new Error('storage response lost after commit');
      }
      return result;
    },
    validateMigrationSource: async () => { throw new Error('not used'); },
  };
}

function applyMove(
  atoms: Map<string, MemoryAtom>,
  request: MemoryAtomManagementRequest,
): MemoryAtomManagementResult {
  if (request.action !== 'move') throw new Error('test facade only supports move');
  const current = atoms.get(request.atomId)!;
  if (current.revision !== request.expectedRevision) throw new Error('revision conflict');
  const updated: MemoryAtom = {
    ...current,
    parentId: request.parentNodeId,
    revision: current.revision + 1,
    updatedAt: '2026-07-17T09:00:00.000Z',
  };
  atoms.set(updated.id, updated);
  return {
    action: 'move',
    atoms: [structuredClone(updated)],
    audit: {
      id: `audit:${updated.id}`,
      action: 'move',
      at: updated.updatedAt,
      reason: request.reason,
      atomIds: [updated.id],
      before: [state(current)],
      after: [state(updated)],
    },
  };
}

function state(atom: MemoryAtom) {
  return {
    atomId: atom.id,
    revision: atom.revision,
    parentId: atom.parentId,
    status: atom.status,
    epistemicStatus: atom.epistemicStatus,
    resolutionStatus: atom.resolutionStatus,
  };
}
