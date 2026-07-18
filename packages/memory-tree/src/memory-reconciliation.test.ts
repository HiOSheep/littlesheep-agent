import { describe, expect, it, vi } from 'vitest';
import type { MemoryAtom, MemoryRelationNeighborhood } from './v3/contracts.js';
import { makeStoredAtom } from './v3/test-fixtures.js';
import type {
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryRepositoryManagementFacade,
} from './memory-repository/management.js';
import {
  MemoryAtomReconciliationService,
  type MemoryAtomMergeProposal,
} from './memory-reconciliation.js';

describe('MemoryAtomReconciliationService', () => {
  it('commits a bounded duplicate merge and treats the same proposal as idempotent after retry', async () => {
    const atoms = atomMap(
      atom('target', 'Use pnpm for workspace commands.', ['pnpm', 'workspace']),
      atom('source', 'The workspace uses pnpm commands.', ['pnpm', 'workspace']),
    );
    const invalidate = vi.fn(async () => undefined);
    const service = new MemoryAtomReconciliationService({
      management: fakeManagement(atoms),
      invalidate,
    });
    const proposal = mergeProposal('target', ['source']);

    const [first] = await service.reconcile([proposal]);
    const [second] = await service.reconcile([proposal]);

    expect(first).toMatchObject({
      status: 'committed',
      committedSourceAtomIds: ['source'],
      remainingSourceAtomIds: [],
    });
    expect(atoms.get('target')).toMatchObject({ revision: 2, mergedFromAtomIds: ['source'] });
    expect(atoms.get('source')).toMatchObject({
      revision: 2,
      status: 'tombstone',
      merge: { intoAtomId: 'target' },
    });
    expect(second).toMatchObject({ status: 'noop', committedSourceAtomIds: ['source'] });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable partial result without modifying the uncommitted source', async () => {
    const atoms = atomMap(
      atom('target', 'Use pnpm for workspace commands.', ['pnpm', 'workspace']),
      atom('source-a', 'The workspace uses pnpm commands.', ['pnpm', 'workspace']),
      atom('source-b', 'pnpm is the workspace package command.', ['pnpm', 'workspace']),
    );
    const management = fakeManagement(atoms, { failOnceFor: 'source-b' });
    const service = new MemoryAtomReconciliationService({ management });
    const proposal = mergeProposal('target', ['source-a', 'source-b']);

    const [first] = await service.reconcile([proposal]);
    expect(first).toMatchObject({
      status: 'partial',
      committedSourceAtomIds: ['source-a'],
      remainingSourceAtomIds: ['source-b'],
    });
    expect(atoms.get('source-b')).toMatchObject({ revision: 1, status: 'active' });

    const [retried] = await service.reconcile([proposal]);
    expect(retried).toMatchObject({
      status: 'committed',
      committedSourceAtomIds: ['source-a', 'source-b'],
      remainingSourceAtomIds: [],
    });
    expect(atoms.get('target')?.revision).toBe(3);
  });

  it('rejects unrelated atoms and explicit conflict or replacement relations', async () => {
    const unrelated = atomMap(
      atom('target', 'Use pnpm for workspace commands.', ['pnpm']),
      atom('source', 'The deployment database uses SQLite.', ['sqlite', 'database']),
    );
    const unrelatedService = new MemoryAtomReconciliationService({ management: fakeManagement(unrelated) });
    await expect(unrelatedService.reconcile([mergeProposal('target', ['source'])]))
      .resolves.toEqual([expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('duplicate anchor') })]);

    const target = atom('target', 'Use pnpm for workspace commands.', ['pnpm'], ['entity:new']);
    const source = atom('source', 'The workspace uses pnpm commands.', ['pnpm'], ['entity:old']);
    const conflicted = atomMap(target, source);
    const relation = {
      version: 1 as const,
      id: 'relation:replacement',
      fromEntityId: 'entity:new',
      toEntityId: 'entity:old',
      type: 'replaces' as const,
      scope: 'project' as const,
      scopeKey: 'project-a',
      source: { kind: 'tool' as const, id: 'test-tool' },
      sourceRefs: ['conversation-source:test'],
      evidenceRefs: ['tool:test'],
      confidence: 0.9,
      authorityScope: target.authorityScope,
      relevance: 0.9,
      status: 'active' as const,
      resolutionStatus: 'resolved' as const,
      revision: 1,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };
    const neighborhood: MemoryRelationNeighborhood = { entities: [], relations: [relation], truncated: false };
    const conflictService = new MemoryAtomReconciliationService({
      management: fakeManagement(conflicted, { neighborhoods: new Map([['target', neighborhood]]) }),
    });
    await expect(conflictService.reconcile([mergeProposal('target', ['source'])]))
      .resolves.toEqual([expect.objectContaining({ status: 'rejected', reason: expect.stringContaining('relation prevents') })]);
  });
});

function atom(
  id: string,
  content: string,
  retrievalKeys: string[],
  entityRefs: string[] = [],
): MemoryAtom {
  return makeStoredAtom({
    id,
    parentId: 'project:root',
    title: id,
    summary: content,
    content,
    retrievalKeys,
    entityRefs,
    sourceRefs: [`conversation-source:${id}`],
    evidenceRefs: [`tool:${id}`],
  });
}

function atomMap(...atoms: MemoryAtom[]): Map<string, MemoryAtom> {
  return new Map(atoms.map((candidate) => [candidate.id, structuredClone(candidate)]));
}

function mergeProposal(targetAtomId: string, sourceAtomIds: string[]): MemoryAtomMergeProposal {
  return {
    id: 'run:test:reconciliation:1',
    action: 'merge',
    basis: 'duplicate-projection',
    target: { atomId: targetAtomId, expectedRevision: 1 },
    sources: sourceAtomIds.map((atomId) => ({ atomId, expectedRevision: 1 })),
    reason: 'These projections express the same verified workspace rule.',
    evidenceRefs: ['run:test:verification:1:pass'],
  };
}

function fakeManagement(
  atoms: Map<string, MemoryAtom>,
  options: {
    failOnceFor?: string;
    neighborhoods?: Map<string, MemoryRelationNeighborhood>;
  } = {},
): MemoryRepositoryManagementFacade {
  let failed = false;
  return {
    status: async () => ({ backendKind: 'v3', storageKind: 'atom-catalog', retrievalSupported: true }),
    inspectNode: async (nodeId, disclosureLevel) => {
      const atom = atoms.get(nodeId);
      return atom ? {
        backendKind: 'v3' as const,
        nodeId,
        disclosureLevel,
        atom: structuredClone(atom),
        neighborhood: options.neighborhoods?.get(nodeId),
      } : undefined;
    },
    manageAtom: async (request) => {
      if (request.action !== 'merge') throw new Error('test facade only supports merge');
      if (!failed && options.failOnceFor === request.atomId) {
        failed = true;
        throw new Error('temporary storage failure');
      }
      return applyMerge(atoms, request);
    },
    validateMigrationSource: async () => { throw new Error('not used'); },
  };
}

function applyMerge(
  atoms: Map<string, MemoryAtom>,
  request: Extract<MemoryAtomManagementRequest, { action: 'merge' }>,
): MemoryAtomManagementResult {
  const source = atoms.get(request.atomId)!;
  const target = atoms.get(request.targetAtomId)!;
  if (source.revision !== request.expectedRevision || target.revision !== request.targetExpectedRevision) {
    throw new Error('revision conflict');
  }
  const at = '2026-07-17T08:00:00.000Z';
  const updatedTarget: MemoryAtom = {
    ...target,
    revision: target.revision + 1,
    mergedFromAtomIds: [...new Set([...(target.mergedFromAtomIds ?? []), source.id])],
    updatedAt: at,
  };
  const updatedSource: MemoryAtom = {
    ...source,
    revision: source.revision + 1,
    status: 'tombstone',
    merge: { intoAtomId: target.id, at, reason: request.reason },
    updatedAt: at,
  };
  atoms.set(updatedTarget.id, updatedTarget);
  atoms.set(updatedSource.id, updatedSource);
  return {
    action: 'merge',
    atoms: [structuredClone(updatedTarget), structuredClone(updatedSource)],
    audit: {
      id: `audit:${source.id}`,
      action: 'merge',
      at,
      reason: request.reason,
      atomIds: [target.id, source.id],
      before: [
        state(target),
        state(source),
      ],
      after: [
        state(updatedTarget),
        state(updatedSource),
      ],
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
