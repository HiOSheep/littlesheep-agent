import { describe, expect, it, vi } from 'vitest';
import type { MemoryAtom, MemoryRelation, MemoryRelationNeighborhood } from './v3/contracts.js';
import { makeStoredAtom } from './v3/test-fixtures.js';
import type {
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryRepositoryManagementFacade,
} from './memory-repository/management.js';
import {
  MemoryAtomHierarchyService,
  type MemoryAtomReparentProposal,
} from './memory-hierarchy.js';

describe('MemoryAtomHierarchyService', () => {
  it('moves one evidenced leaf atom and recognizes the committed retry as a noop', async () => {
    const child = atom('child', 'old-parent', ['entity:child']);
    const parent = atom('new-parent', 'project:root', ['entity:parent']);
    const atoms = atomMap(child, parent);
    const relation = parentRelation(child, parent);
    const neighborhood = relationNeighborhood(relation);
    const invalidate = vi.fn(async () => undefined);
    const service = new MemoryAtomHierarchyService({
      management: fakeManagement(atoms, { neighborhoods: new Map([['child', neighborhood], ['new-parent', neighborhood]]) }),
      invalidate,
    });
    const proposal = reparentProposal();

    const [first] = await service.reparent([proposal]);
    const [retried] = await service.reparent([proposal]);

    expect(first).toMatchObject({
      status: 'committed',
      atomId: 'child',
      parentAtomId: 'new-parent',
      committed: true,
    });
    expect(atoms.get('child')).toMatchObject({ parentId: 'new-parent', revision: 2 });
    expect(retried).toMatchObject({ status: 'noop', committed: false });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('recovers an unknown commit outcome without repeating the move', async () => {
    const child = atom('child', 'old-parent', ['entity:child']);
    const parent = atom('new-parent', 'project:root', ['entity:parent']);
    const atoms = atomMap(child, parent);
    const relation = parentRelation(child, parent);
    const neighborhood = relationNeighborhood(relation);
    const invalidate = vi.fn(async () => undefined);
    const service = new MemoryAtomHierarchyService({
      management: fakeManagement(atoms, {
        neighborhoods: new Map([['child', neighborhood], ['new-parent', neighborhood]]),
        throwAfterCommitOnce: true,
      }),
      invalidate,
    });

    const [uncertain] = await service.reparent([reparentProposal()]);
    const [recovered] = await service.reparent([reparentProposal()]);

    expect(uncertain).toMatchObject({ status: 'deferred', committed: false });
    expect(atoms.get('child')).toMatchObject({ parentId: 'new-parent', revision: 2 });
    expect(recovered).toMatchObject({ status: 'noop', committed: false });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-leaf atom and a relation whose direction does not prove ownership', async () => {
    const child = atom('child', 'old-parent', ['entity:child']);
    const parent = atom('new-parent', 'project:root', ['entity:parent']);
    const atoms = atomMap(child, parent);
    const valid = parentRelation(child, parent);
    const nonLeaf = new MemoryAtomHierarchyService({
      management: fakeManagement(atoms, {
        neighborhoods: new Map([['child', relationNeighborhood(valid)], ['new-parent', relationNeighborhood(valid)]]),
        activeChildren: new Set(['child']),
      }),
    });
    await expect(nonLeaf.reparent([reparentProposal()])).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('active children') }),
    ]);

    const reverse = { ...valid, fromEntityId: 'entity:parent', toEntityId: 'entity:child' };
    const wrongDirection = new MemoryAtomHierarchyService({
      management: fakeManagement(atoms, {
        neighborhoods: new Map([['child', relationNeighborhood(reverse)], ['new-parent', relationNeighborhood(reverse)]]),
      }),
    });
    await expect(wrongDirection.reparent([reparentProposal()])).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('No active, resolved') }),
    ]);
  });

  it('rejects weak, unresolved and cross-scope hierarchy evidence', async () => {
    const child = atom('child', 'old-parent', ['entity:child']);
    const parent = atom('new-parent', 'project:root', ['entity:parent']);
    const weak = { ...parentRelation(child, parent), confidence: 0.4 };
    const weakService = new MemoryAtomHierarchyService({
      management: fakeManagement(atomMap(child, parent), {
        neighborhoods: new Map([['child', relationNeighborhood(weak)], ['new-parent', relationNeighborhood(weak)]]),
      }),
    });
    await expect(weakService.reparent([reparentProposal()])).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('No active, resolved') }),
    ]);

    const otherScopeParent = makeStoredAtom({
      ...parent,
      id: 'other-parent',
      scopeKey: 'project-b',
      authorityScope: { ...parent.authorityScope, scopeKey: 'project-b' },
    });
    const crossScope = new MemoryAtomHierarchyService({ management: fakeManagement(atomMap(child, otherScopeParent)) });
    await expect(crossScope.reparent([{ ...reparentProposal(), parent: { atomId: 'other-parent', expectedRevision: 1 } }]))
      .resolves.toEqual([expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('scope boundary') })]);
  });
});

function atom(id: string, parentId: string, entityRefs: string[]): MemoryAtom {
  return makeStoredAtom({
    id,
    parentId,
    title: id,
    summary: `${id} hierarchy projection`,
    content: `${id} belongs in the project hierarchy.`,
    retrievalKeys: [id, 'hierarchy'],
    entityRefs,
  });
}

function parentRelation(child: MemoryAtom, parent: MemoryAtom): MemoryRelation {
  return {
    version: 1,
    id: 'relation:child-belongs-to-parent',
    fromEntityId: child.entityRefs[0]!,
    toEntityId: parent.entityRefs[0]!,
    type: 'belongs-to',
    scope: 'project',
    scopeKey: 'project-a',
    source: { kind: 'tool', id: 'test-tool' },
    sourceRefs: ['conversation-source:hierarchy'],
    evidenceRefs: ['tool:hierarchy'],
    confidence: 0.9,
    authorityScope: child.authorityScope,
    relevance: 0.9,
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
  };
}

function relationNeighborhood(relation: MemoryRelation): MemoryRelationNeighborhood {
  return { entities: [], relations: [relation], truncated: false };
}

function reparentProposal(): MemoryAtomReparentProposal {
  return {
    id: 'run:test:reparent:1',
    action: 'move',
    basis: 'explicit-parent-relation',
    atom: { atomId: 'child', expectedRevision: 1 },
    parent: { atomId: 'new-parent', expectedRevision: 1 },
    relationId: 'relation:child-belongs-to-parent',
    reason: 'The active ownership relation proves this semantic parent correction.',
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
    activeChildren?: Set<string>;
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
        hasActiveChildren: options.activeChildren?.has(nodeId) ?? false,
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
