import { describe, expect, it, vi } from 'vitest';
import type { MemoryAtom, MemoryRelation } from './v3/contracts.js';
import { memoryAtomContentHash } from './v3/atom-store.js';
import { makeStoredAtom } from './v3/test-fixtures.js';
import type {
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryRepositoryManagementFacade,
} from './memory-repository/management.js';
import {
  MemoryAtomCorrectionService,
  type MemoryAtomCorrectionProposal,
} from './memory-correction.js';

describe('MemoryAtomCorrectionService', () => {
  it('supersedes the older projection without rewriting either Atom and treats a retry as noop', async () => {
    const oldAtom = atom('atom-old', 'Remote embeddings are required.', 'entity:old');
    const replacement = atom('atom-new', 'Only local embeddings are required.', 'entity:new');
    const atoms = new Map([[oldAtom.id, oldAtom], [replacement.id, replacement]]);
    const invalidate = vi.fn(async () => undefined);
    const service = new MemoryAtomCorrectionService({
      management: fakeManagement(atoms, replacementRelation()),
      invalidate,
    });

    const [committed] = await service.resolve([proposal()]);
    const [retried] = await service.resolve([proposal()]);

    expect(committed).toMatchObject({
      status: 'committed',
      committed: true,
      supersededAtomId: oldAtom.id,
      replacementAtomId: replacement.id,
      previousRevision: 1,
      revision: 2,
    });
    expect(atoms.get(oldAtom.id)).toMatchObject({
      revision: 2,
      title: oldAtom.title,
      summary: oldAtom.summary,
      content: oldAtom.content,
      epistemicStatus: 'superseded',
      resolutionStatus: 'superseded',
      supersession: {
        byAtomId: replacement.id,
        relationId: 'relation:new-replaces-old',
        priorEpistemicStatus: oldAtom.epistemicStatus,
        priorResolutionStatus: oldAtom.resolutionStatus,
      },
    });
    expect(atoms.get(replacement.id)).toEqual(replacement);
    expect(retried).toMatchObject({ status: 'noop', committed: false, revision: 2 });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost post-commit response without superseding twice', async () => {
    const oldAtom = atom('atom-old', 'Remote embeddings are required.', 'entity:old');
    const replacement = atom('atom-new', 'Only local embeddings are required.', 'entity:new');
    const atoms = new Map([[oldAtom.id, oldAtom], [replacement.id, replacement]]);
    const manageAtom = vi.fn(fakeSupersedeManager(atoms, { throwAfterCommitOnce: true }));
    const service = new MemoryAtomCorrectionService({
      management: fakeManagement(atoms, replacementRelation(), { manageAtom }),
    });

    const [uncertain] = await service.resolve([proposal()]);
    const [recovered] = await service.resolve([proposal()]);

    expect(uncertain).toMatchObject({ status: 'deferred', committed: false, revision: 1 });
    expect(atoms.get(oldAtom.id)).toMatchObject({ revision: 2, epistemicStatus: 'superseded' });
    expect(recovered).toMatchObject({ status: 'noop', committed: false, revision: 2 });
    expect(manageAtom).toHaveBeenCalledTimes(1);
  });

  it('rejects stale revisions, weak relations and reversed replacement direction', async () => {
    const cases: Array<{ replacement: MemoryAtom; relation: MemoryRelation; reason: string }> = [
      {
        replacement: atom('atom-new', 'Only local embeddings are required.', 'entity:new', { revision: 2 }),
        relation: replacementRelation(),
        reason: 'revision changed',
      },
      {
        replacement: atom('atom-new', 'Only local embeddings are required.', 'entity:new'),
        relation: replacementRelation({ confidence: 0.4 }),
        reason: 'No active, resolved and evidenced',
      },
      {
        replacement: atom('atom-new', 'Only local embeddings are required.', 'entity:new'),
        relation: replacementRelation({ fromEntityId: 'entity:old', toEntityId: 'entity:new' }),
        reason: 'No active, resolved and evidenced',
      },
    ];

    for (const testCase of cases) {
      const oldAtom = atom('atom-old', 'Remote embeddings are required.', 'entity:old');
      const atoms = new Map([[oldAtom.id, oldAtom], [testCase.replacement.id, testCase.replacement]]);
      const manageAtom = vi.fn(fakeSupersedeManager(atoms));
      const service = new MemoryAtomCorrectionService({
        management: fakeManagement(atoms, testCase.relation, { manageAtom }),
      });

      const [result] = await service.resolve([proposal()]);

      expect(result).toMatchObject({ status: 'rejected', committed: false });
      expect(result?.reason).toContain(testCase.reason);
      expect(manageAtom).not.toHaveBeenCalled();
    }
  });

  it('rejects a replacement that lacks verified authority', async () => {
    const oldAtom = atom('atom-old', 'Remote embeddings are required.', 'entity:old');
    const replacement = atom('atom-new', 'Only local embeddings are required.', 'entity:new', {
      epistemicStatus: 'unverified',
      confidence: 0.95,
    });
    const atoms = new Map([[oldAtom.id, oldAtom], [replacement.id, replacement]]);
    const manageAtom = vi.fn(fakeSupersedeManager(atoms));
    const service = new MemoryAtomCorrectionService({
      management: fakeManagement(atoms, replacementRelation(), { manageAtom }),
    });

    const [result] = await service.resolve([proposal()]);

    expect(result).toMatchObject({ status: 'rejected', committed: false });
    expect(result?.reason).toContain('authority or evidence');
    expect(manageAtom).not.toHaveBeenCalled();
  });

  it('accepts an evidenced conflicts-with relation for conflict replacement', async () => {
    const oldAtom = atom('atom-old', 'Remote embeddings are required.', 'entity:old');
    const replacement = atom('atom-new', 'Only local embeddings are required.', 'entity:new');
    const atoms = new Map([[oldAtom.id, oldAtom], [replacement.id, replacement]]);
    const relation = replacementRelation({ type: 'conflicts-with' });
    const service = new MemoryAtomCorrectionService({
      management: fakeManagement(atoms, relation),
    });

    const [result] = await service.resolve([{
      ...proposal(),
      basis: 'conflict-replacement',
    }]);

    expect(result).toMatchObject({ status: 'committed', committed: true, revision: 2 });
  });
});

function atom(
  id: string,
  content: string,
  entityId: string,
  overrides: Partial<MemoryAtom> = {},
): MemoryAtom {
  return storedAtom({
    id,
    parentId: 'atom-policy-parent',
    title: id === 'atom-old' ? 'Legacy embedding policy' : 'Current embedding policy',
    summary: content,
    content,
    retrievalKeys: ['embedding', id === 'atom-old' ? 'remote' : 'local'],
    entityRefs: [entityId],
    relationRefs: ['relation:new-replaces-old'],
    resolutionStatus: 'resolved',
    ...overrides,
  });
}

function storedAtom(overrides: Partial<MemoryAtom>): MemoryAtom {
  const base = { ...makeStoredAtom(), ...overrides } as MemoryAtom;
  const withoutHash = { ...base };
  delete (withoutHash as Partial<MemoryAtom>).contentHash;
  return { ...withoutHash, contentHash: memoryAtomContentHash(withoutHash) } as MemoryAtom;
}

function replacementRelation(overrides: Partial<MemoryRelation> = {}): MemoryRelation {
  return {
    version: 1,
    id: 'relation:new-replaces-old',
    fromEntityId: 'entity:new',
    toEntityId: 'entity:old',
    type: 'replaces',
    scope: 'project',
    scopeKey: 'project-a',
    source: { kind: 'tool', id: 'correction-test' },
    sourceRefs: ['conversation-source:correction-test'],
    evidenceRefs: ['tool:correction-test'],
    confidence: 0.95,
    authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey: 'project-a', topics: ['embedding'] },
    relevance: 0.9,
    feedbackRevision: 0,
    recentFeedbackIds: [],
    status: 'active',
    resolutionStatus: 'resolved',
    revision: 1,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
    ...overrides,
  };
}

function proposal(): MemoryAtomCorrectionProposal {
  return {
    id: 'run:test:evolve:correction:1',
    action: 'supersede',
    basis: 'evidence-backed-correction',
    superseded: { atomId: 'atom-old', expectedRevision: 1 },
    replacement: { atomId: 'atom-new', expectedRevision: 1 },
    relationId: 'relation:new-replaces-old',
    reason: 'Verified tool evidence proves that the local-only policy replaces the older remote policy.',
    evidenceRefs: ['run:test:verification:1:pass'],
  };
}

function fakeManagement(
  atoms: Map<string, MemoryAtom>,
  relation: MemoryRelation,
  options: { manageAtom?: MemoryRepositoryManagementFacade['manageAtom'] } = {},
): MemoryRepositoryManagementFacade {
  return {
    status: async () => ({ backendKind: 'v3', storageKind: 'atom-catalog', retrievalSupported: true }),
    inspectNode: async (nodeId, disclosureLevel) => {
      const candidate = atoms.get(nodeId);
      return candidate ? {
        backendKind: 'v3' as const,
        nodeId,
        disclosureLevel,
        atom: structuredClone(candidate),
        neighborhood: { entities: [], relations: [structuredClone(relation)], truncated: false },
        hasActiveChildren: false,
      } : undefined;
    },
    manageAtom: options.manageAtom ?? fakeSupersedeManager(atoms),
    validateMigrationSource: async () => { throw new Error('not used'); },
  };
}

function fakeSupersedeManager(
  atoms: Map<string, MemoryAtom>,
  options: { throwAfterCommitOnce?: boolean } = {},
): MemoryRepositoryManagementFacade['manageAtom'] {
  let threwAfterCommit = false;
  return async (request) => {
    const result = applySupersession(atoms, request);
    if (options.throwAfterCommitOnce && !threwAfterCommit) {
      threwAfterCommit = true;
      throw new Error('storage response lost after commit');
    }
    return result;
  };
}

function applySupersession(
  atoms: Map<string, MemoryAtom>,
  request: MemoryAtomManagementRequest,
): MemoryAtomManagementResult {
  if (request.action !== 'supersede') throw new Error('test facade only supports supersede');
  const current = atoms.get(request.atomId);
  const replacement = atoms.get(request.replacementAtomId);
  if (!current || !replacement) throw new Error('atom not found');
  if (current.revision !== request.expectedRevision
    || replacement.revision !== request.replacementExpectedRevision) {
    throw new Error('revision conflict');
  }
  const updated = storedAtom({
    ...current,
    revision: current.revision + 1,
    epistemicStatus: 'superseded',
    resolutionStatus: 'superseded',
    supersession: {
      byAtomId: replacement.id,
      relationId: request.relationId,
      at: '2026-07-17T10:00:01.000Z',
      reason: request.reason,
      priorEpistemicStatus: current.epistemicStatus,
      priorResolutionStatus: current.resolutionStatus,
    },
    updatedAt: '2026-07-17T10:00:01.000Z',
  });
  atoms.set(updated.id, updated);
  return {
    action: 'supersede',
    atoms: [structuredClone(updated)],
    audit: {
      id: `audit:${updated.id}:${updated.revision}`,
      action: 'supersede',
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
    contentHash: atom.contentHash,
    parentId: atom.parentId,
    status: atom.status,
    epistemicStatus: atom.epistemicStatus,
    resolutionStatus: atom.resolutionStatus,
  };
}
